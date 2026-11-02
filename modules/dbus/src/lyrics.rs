//! A read-only D-Bus service that publishes the current lyrics and track.
//!
//! The service is deliberately pull-based: it stores the lyrics document and
//! track metadata, then answers `GetLyrics`/`GetLineAt` when a client asks.
//! Playback position is not tracked here — clients take it from MPRIS and pass
//! it to `GetLineAt`, which keeps the service free of timer/per-tick work.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard};

use napi::bindgen_prelude::Object;
use napi::{Env, Error, Result};
use napi_derive::napi;
use serde::Serialize;
use zbus::fdo::RequestNameFlags;
use zbus::object_server::{InterfaceRef, SignalEmitter};
use zbus::{fdo, interface, Connection, ObjectPath, OwnedObjectPath};

/// The D-Bus interface served at [`DEFAULT_OBJECT_PATH`].
pub const LYRICS_INTERFACE: &str = "io.github.yucling.OpenOrpheus.Lyrics";

/// The default object path of the lyrics service.
pub const DEFAULT_OBJECT_PATH: &str = "/io/github/yucling/OpenOrpheus/Lyrics";

/// A single timed word (or, for plain LRC, the whole line).
#[napi(object)]
#[derive(Clone, Serialize)]
pub struct DbusLyricsWord {
    /// Text of this word.
    pub text: String,
    /// Start time in milliseconds, relative to the line.
    pub start_time: f64,
    /// Duration in milliseconds.
    pub duration: f64,
}

/// A single lyric line.
#[napi(object)]
#[derive(Clone, Serialize)]
pub struct DbusLyricsLine {
    /// Start time in milliseconds.
    pub start_time: f64,
    /// End time in milliseconds.
    pub end_time: f64,
    /// Timed words, relative to the line.
    pub words: Vec<DbusLyricsWord>,
}

/// The app's `LyricsStore`, as published by `GetLyrics`.
#[napi(object)]
#[derive(Clone, Serialize)]
pub struct DbusLyricsDocument {
    /// Plain or per-word primary lyrics.
    pub regular: Vec<DbusLyricsLine>,
    /// Per-word lyrics, when available.
    #[serde(rename = "per-word", skip_serializing_if = "Option::is_none")]
    pub per_word: Option<Vec<DbusLyricsLine>>,
    /// Translation lines, when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translate: Option<Vec<DbusLyricsLine>>,
    /// Romanization lines, when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roma: Option<Vec<DbusLyricsLine>>,
}

/// Track metadata published as properties.
#[napi(object)]
#[derive(Clone)]
pub struct DbusLyricsTrack {
    /// Current play id.
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// Track duration in milliseconds.
    pub duration: Option<f64>,
}

impl DbusLyricsTrack {
    fn duration_ms(&self) -> i64 {
        self.duration
            .map(|duration| duration.max(0.0).round() as i64)
            .unwrap_or(0)
    }
}

/// The properties derived from the current track.
#[derive(Clone, PartialEq)]
struct TrackProperties {
    track_id: String,
    title: String,
    artist: String,
    album: String,
    duration: i64,
}

impl TrackProperties {
    fn from_track(track: Option<&DbusLyricsTrack>) -> Self {
        match track {
            Some(track) => Self {
                track_id: track.id.clone(),
                title: track.title.clone(),
                artist: track.artist.clone(),
                album: track.album.clone(),
                duration: track.duration_ms(),
            },
            None => Self {
                track_id: String::new(),
                title: String::new(),
                artist: String::new(),
                album: String::new(),
                duration: 0,
            },
        }
    }
}

/// The properties derived from the current lyrics document.
#[derive(Clone, Copy, PartialEq)]
struct LyricsProperties {
    available: bool,
    has_per_word: bool,
    has_translation: bool,
    has_roma: bool,
}

impl LyricsProperties {
    fn from_document(document: Option<&DbusLyricsDocument>) -> Self {
        let has_lines =
            |lines: Option<&Vec<DbusLyricsLine>>| lines.is_some_and(|lines| !lines.is_empty());
        Self {
            available: document.is_some_and(|document| {
                !document.regular.is_empty() || has_lines(document.per_word.as_ref())
            }),
            has_per_word: document.is_some_and(|document| has_lines(document.per_word.as_ref())),
            has_translation: document
                .is_some_and(|document| has_lines(document.translate.as_ref())),
            has_roma: document.is_some_and(|document| has_lines(document.roma.as_ref())),
        }
    }
}

/// The mutable state shared by the zbus interface and the JS-facing service.
///
/// Kept behind its own lock, following the MPRIS `PlayerState` pattern: zbus
/// holds a read lock on an interface for the duration of every `&self` method,
/// so updates coming from JS must never ask zbus for a write lock.
pub struct LyricsState {
    track: Option<DbusLyricsTrack>,
    lyrics: Option<DbusLyricsDocument>,
    /// Pre-serialized `GetLyrics` payload (`"null"` when there are none).
    lyrics_json: String,
    slogan: Option<String>,
}

impl Default for LyricsState {
    fn default() -> Self {
        Self {
            track: None,
            lyrics: None,
            lyrics_json: "null".to_string(),
            slogan: None,
        }
    }
}

/// Lock a `std::sync::Mutex`, recovering the guard if a previous holder
/// panicked. The locks below are always released before awaiting, so poisoning
/// is not a meaningful signal.
fn lock<T>(mutex: &StdMutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Serialize a lyrics document into the `GetLyrics` payload.
fn lyrics_json(document: Option<&DbusLyricsDocument>) -> std::result::Result<String, String> {
    match document {
        Some(document) => serde_json::to_string(document).map_err(|error| error.to_string()),
        None => Ok("null".to_string()),
    }
}

/// The primary line list: per-word lyrics when present, otherwise regular.
fn primary_lines(document: &DbusLyricsDocument) -> &[DbusLyricsLine] {
    match document.per_word.as_deref() {
        Some(lines) if !lines.is_empty() => lines,
        _ => &document.regular,
    }
}

/// The last line whose start is at or before `time`.
fn index_at(lines: &[DbusLyricsLine], time: f64) -> Option<usize> {
    if lines.is_empty() {
        return None;
    }

    let mut low = 0usize;
    let mut high = lines.len();
    while low < high {
        let middle = low + (high - low) / 2;
        if lines[middle].start_time <= time {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    low.checked_sub(1)
}

/// Like [`index_at`], but only returns a line that covers `time`, except for
/// the last line which stays visible after it ends (matching the UI).
fn overlap_at(lines: &[DbusLyricsLine], time: f64) -> Option<usize> {
    let index = index_at(lines, time)?;
    if index + 1 == lines.len() || time < lines[index].end_time {
        Some(index)
    } else {
        None
    }
}

/// Concatenate a line's words into its display text.
fn line_text(line: &DbusLyricsLine) -> String {
    let mut text = String::new();
    for word in &line.words {
        text.push_str(&word.text);
    }
    text
}

/// The text of the line covering `time`, if any.
fn text_at(lines: Option<&Vec<DbusLyricsLine>>, time: f64) -> Option<String> {
    let lines = lines?;
    let index = overlap_at(lines, time)?;
    Some(line_text(&lines[index]))
}

/// A line as returned by `GetLineAt`.
#[derive(Serialize)]
struct LineJson<'a> {
    index: usize,
    start_time: f64,
    end_time: f64,
    text: String,
    translation: Option<String>,
    roma: Option<String>,
    words: &'a [DbusLyricsWord],
}

/// Build the `GetLineAt` reply for `document`.
fn line_json(document: &DbusLyricsDocument, position_ms: i64) -> Option<LineJson<'_>> {
    let time = position_ms as f64;
    let lines = primary_lines(document);
    let index = index_at(lines, time)?;
    let line = &lines[index];

    Some(LineJson {
        index,
        start_time: line.start_time,
        end_time: line.end_time,
        text: line_text(line),
        translation: text_at(document.translate.as_ref(), time),
        roma: text_at(document.roma.as_ref(), time),
        words: &line.words,
    })
}

/// The zbus interface served by [`LyricsService`].
pub struct LyricsInterface {
    state: Arc<StdMutex<LyricsState>>,
}

impl LyricsInterface {
    fn track_properties(&self) -> TrackProperties {
        TrackProperties::from_track(lock(&self.state).track.as_ref())
    }

    fn lyrics_properties(&self) -> LyricsProperties {
        LyricsProperties::from_document(lock(&self.state).lyrics.as_ref())
    }
}

#[interface(name = "io.github.yucling.OpenOrpheus.Lyrics")]
impl LyricsInterface {
    /// The current lyrics document as JSON, or `"null"` when unavailable.
    ///
    /// The payload uses the app's `LyricsStore` schema: `regular`, optional
    /// `per-word`, `translate`, and `roma` line arrays. All times are
    /// milliseconds.
    fn get_lyrics(&self) -> std::result::Result<String, fdo::Error> {
        Ok(lock(&self.state).lyrics_json.clone())
    }

    /// The lyric line at `position_ms`, as JSON.
    ///
    /// Returns `"null"` before the first line. The line object contains
    /// `index`, `start_time`, `end_time`, `text`, `words`, and optional
    /// `translation`/`roma` text. Times are milliseconds.
    fn get_line_at(&self, position_ms: i64) -> std::result::Result<String, fdo::Error> {
        let state = lock(&self.state);
        let Some(document) = state.lyrics.as_ref() else {
            return Ok("null".to_string());
        };

        match line_json(document, position_ms) {
            Some(line) => {
                serde_json::to_string(&line).map_err(|error| fdo::Error::Failed(error.to_string()))
            }
            None => Ok("null".to_string()),
        }
    }

    /// Whether any primary lyric lines are available.
    #[zbus(property)]
    fn available(&self) -> bool {
        self.lyrics_properties().available
    }

    /// The current slogan, empty when none.
    #[zbus(property)]
    fn slogan(&self) -> String {
        lock(&self.state).slogan.clone().unwrap_or_default()
    }

    /// The current play id, empty when no track is known.
    #[zbus(property)]
    fn track_id(&self) -> String {
        self.track_properties().track_id
    }

    /// The current track title.
    #[zbus(property)]
    fn title(&self) -> String {
        self.track_properties().title
    }

    /// The current track artist.
    #[zbus(property)]
    fn artist(&self) -> String {
        self.track_properties().artist
    }

    /// The current track album.
    #[zbus(property)]
    fn album(&self) -> String {
        self.track_properties().album
    }

    /// The current track duration in milliseconds, or `0` when unknown.
    #[zbus(property)]
    fn duration(&self) -> i64 {
        self.track_properties().duration
    }

    /// Whether per-word lyrics are available.
    #[zbus(property)]
    fn has_per_word(&self) -> bool {
        self.lyrics_properties().has_per_word
    }

    /// Whether translation lyrics are available.
    #[zbus(property)]
    fn has_translation(&self) -> bool {
        self.lyrics_properties().has_translation
    }

    /// Whether romanization lyrics are available.
    #[zbus(property)]
    fn has_roma(&self) -> bool {
        self.lyrics_properties().has_roma
    }

    /// Emitted when the lyrics document or slogan changes.
    #[zbus(signal)]
    async fn lyrics_changed(emitter: &SignalEmitter<'_>) -> zbus::Result<()>;

    /// Emitted when track metadata or duration changes.
    #[zbus(signal)]
    async fn track_changed(emitter: &SignalEmitter<'_>) -> zbus::Result<()>;
}

#[derive(Clone)]
struct ServiceInner {
    conn: Connection,
    path: OwnedObjectPath,
}

/// A session-bus lyrics service.
///
/// The constructor only validates its arguments. Call [`LyricsService::start`]
/// to connect to the session bus, register the interface at `path` (default
/// [`DEFAULT_OBJECT_PATH`]), and request the well-known `name`. Startup is
/// asynchronous so a slow bus never blocks the JavaScript thread.
#[napi]
pub struct LyricsService {
    name: String,
    path: OwnedObjectPath,
    state: Arc<StdMutex<LyricsState>>,
    inner: Arc<StdMutex<Option<ServiceInner>>>,
    disposed: Arc<AtomicBool>,
}

impl LyricsService {
    fn ensure_live(&self) -> Result<()> {
        if self.disposed.load(Ordering::SeqCst) {
            return Err(Error::from_reason("The lyrics service is disposed"));
        }
        Ok(())
    }

    fn inner(&self) -> Result<ServiceInner> {
        self.ensure_live()?;
        lock(&self.inner).clone().ok_or_else(|| {
            Error::from_reason("The lyrics service is not started; call start() first")
        })
    }
}

#[napi]
impl LyricsService {
    /// Create the service. Call [`LyricsService::start`] before using it.
    #[napi(constructor, ts_args_type = "name: string, path?: string")]
    pub fn new(name: String, path: Option<String>) -> Result<Self> {
        let path = path.unwrap_or_else(|| DEFAULT_OBJECT_PATH.to_string());
        let path = ObjectPath::try_from(path.as_str()).map_err(|error| {
            Error::from_reason(format!(
                "invalid lyrics service object path {path:?}: {error}"
            ))
        })?;

        Ok(Self {
            name,
            path: OwnedObjectPath::from(path),
            state: Arc::new(StdMutex::new(LyricsState::default())),
            inner: Arc::new(StdMutex::new(None)),
            disposed: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Connect to the session bus, register the interface, and request `name`.
    ///
    /// This is asynchronous: a slow bus must never block the JavaScript thread.
    /// Calling it more than once is a no-op once the service is running.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn start<'a>(&'a self, env: &'a Env) -> Result<Object<'a>> {
        self.ensure_live()?;

        let name = self.name.clone();
        let path = self.path.clone();
        let state = self.state.clone();
        let slot = self.inner.clone();
        let disposed = self.disposed.clone();

        napi_deferred_task!(env, async move {
            if disposed.load(Ordering::SeqCst) {
                return Err("The lyrics service is disposed".to_string());
            }
            if lock(&slot).is_some() {
                return Ok::<(), String>(());
            }

            let conn = Connection::session()
                .await
                .map_err(|error| error.to_string())?;
            conn.object_server()
                .at(path.clone(), LyricsInterface { state })
                .await
                .map_err(|error| error.to_string())?;
            conn.request_name_with_flags(name, RequestNameFlags::DO_NOT_QUEUE)
                .await
                .map_err(|error| error.to_string())?;

            enum Outcome {
                Stored,
                AlreadyStarted,
                Disposed,
            }

            // The guard is dropped before any await below.
            let outcome = {
                let mut inner = lock(&slot);
                if disposed.load(Ordering::SeqCst) {
                    Outcome::Disposed
                } else if inner.is_some() {
                    Outcome::AlreadyStarted
                } else {
                    *inner = Some(ServiceInner {
                        conn: conn.clone(),
                        path: path.clone(),
                    });
                    Outcome::Stored
                }
            };

            match outcome {
                Outcome::Stored => Ok(()),
                Outcome::AlreadyStarted => {
                    let _ = conn.close().await;
                    Ok(())
                }
                Outcome::Disposed => {
                    let _ = conn.close().await;
                    Err("The lyrics service was disposed during startup".to_string())
                }
            }
        })
    }

    /// Replace the current track metadata and duration.
    ///
    /// `duration` is in milliseconds. Only changed properties emit signals.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn set_track<'a>(
        &'a self,
        env: &'a Env,
        track: Option<DbusLyricsTrack>,
    ) -> Result<Object<'a>> {
        let inner = self.inner()?;
        let state = self.state.clone();

        napi_deferred_task!(env, async move {
            update_track(&inner.conn, &inner.path, &state, track).await
        })
    }

    /// Replace the current lyrics document and slogan together.
    ///
    /// Sending the two atomically avoids a transient state where one has
    /// changed and the other has not. Only changed properties emit signals.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn set_lyrics<'a>(
        &'a self,
        env: &'a Env,
        lyrics: Option<DbusLyricsDocument>,
        slogan: Option<String>,
    ) -> Result<Object<'a>> {
        let inner = self.inner()?;
        let state = self.state.clone();

        napi_deferred_task!(env, async move {
            update_lyrics(&inner.conn, &inner.path, &state, lyrics, slogan).await
        })
    }

    /// Close the connection and release the well-known name.
    ///
    /// Calling this more than once is a no-op.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn dispose<'a>(&'a self, env: &'a Env) -> Result<Object<'a>> {
        let slot = self.inner.clone();
        let disposed = self.disposed.clone();

        napi_deferred_task!(env, async move {
            if disposed.swap(true, Ordering::SeqCst) {
                return Ok::<(), String>(());
            }
            let inner = lock(&slot).take();
            if let Some(inner) = inner {
                inner
                    .conn
                    .close()
                    .await
                    .map_err(|error| error.to_string())?;
            }
            Ok::<(), String>(())
        })
    }
}

/// Look up the lyrics interface on the connection.
async fn lyrics_interface(
    conn: &Connection,
    path: &OwnedObjectPath,
) -> std::result::Result<InterfaceRef<LyricsInterface>, String> {
    conn.object_server()
        .interface::<_, LyricsInterface>(path.clone())
        .await
        .map_err(|error| error.to_string())
}

/// Replace the track metadata and emit the properties/signal it implies.
async fn update_track(
    conn: &Connection,
    path: &OwnedObjectPath,
    state: &Arc<StdMutex<LyricsState>>,
    track: Option<DbusLyricsTrack>,
) -> std::result::Result<(), String> {
    let iface_ref = lyrics_interface(conn, path).await?;
    let iface = iface_ref.get().await;
    let emitter = iface_ref.signal_emitter();

    let after = TrackProperties::from_track(track.as_ref());
    let (before, changed) = {
        let mut state = lock(state);
        let before = TrackProperties::from_track(state.track.as_ref());
        let changed = before != after;
        state.track = track;
        (before, changed)
    };
    if !changed {
        return Ok(());
    }

    if before.track_id != after.track_id {
        iface
            .track_id_changed(emitter)
            .await
            .map_err(|error| error.to_string())?;
    }
    if before.title != after.title {
        iface
            .title_changed(emitter)
            .await
            .map_err(|error| error.to_string())?;
    }
    if before.artist != after.artist {
        iface
            .artist_changed(emitter)
            .await
            .map_err(|error| error.to_string())?;
    }
    if before.album != after.album {
        iface
            .album_changed(emitter)
            .await
            .map_err(|error| error.to_string())?;
    }
    if before.duration != after.duration {
        iface
            .duration_changed(emitter)
            .await
            .map_err(|error| error.to_string())?;
    }

    iface_ref
        .track_changed()
        .await
        .map_err(|error| error.to_string())
}

/// Replace the lyrics/slogan and emit the properties/signal they imply.
async fn update_lyrics(
    conn: &Connection,
    path: &OwnedObjectPath,
    state: &Arc<StdMutex<LyricsState>>,
    lyrics: Option<DbusLyricsDocument>,
    slogan: Option<String>,
) -> std::result::Result<(), String> {
    let json = lyrics_json(lyrics.as_ref())?;
    let after = LyricsProperties::from_document(lyrics.as_ref());

    let iface_ref = lyrics_interface(conn, path).await?;
    let iface = iface_ref.get().await;
    let emitter = iface_ref.signal_emitter();

    let (before, slogan_changed) = {
        let mut state = lock(state);
        let before = LyricsProperties::from_document(state.lyrics.as_ref());
        let slogan_changed = state.slogan != slogan;
        let changed = state.lyrics_json != json || slogan_changed || before != after;
        if !changed {
            return Ok(());
        }

        state.lyrics = lyrics;
        state.lyrics_json = json;
        state.slogan = slogan;
        (before, slogan_changed)
    };

    if before.available != after.available {
        iface
            .available_changed(emitter)
            .await
            .map_err(|error| error.to_string())?;
    }
    if before.has_per_word != after.has_per_word {
        iface
            .has_per_word_changed(emitter)
            .await
            .map_err(|error| error.to_string())?;
    }
    if before.has_translation != after.has_translation {
        iface
            .has_translation_changed(emitter)
            .await
            .map_err(|error| error.to_string())?;
    }
    if before.has_roma != after.has_roma {
        iface
            .has_roma_changed(emitter)
            .await
            .map_err(|error| error.to_string())?;
    }
    if slogan_changed {
        iface
            .slogan_changed(emitter)
            .await
            .map_err(|error| error.to_string())?;
    }

    iface_ref
        .lyrics_changed()
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {

    use super::*;
    use zbus::object_server::Interface;

    fn word(text: &str, start_time: f64, duration: f64) -> DbusLyricsWord {
        DbusLyricsWord {
            text: text.to_string(),
            start_time,
            duration,
        }
    }

    fn line(start_time: f64, end_time: f64, text: &str) -> DbusLyricsLine {
        DbusLyricsLine {
            start_time,
            end_time,
            words: vec![word(text, 0.0, end_time - start_time)],
        }
    }

    fn document() -> DbusLyricsDocument {
        DbusLyricsDocument {
            regular: vec![
                line(0.0, 5_000.0, "hello"),
                line(5_000.0, 10_000.0, "world"),
            ],
            per_word: None,
            translate: Some(vec![
                line(0.0, 5_000.0, "你好"),
                line(5_000.0, 10_000.0, "世界"),
            ]),
            roma: None,
        }
    }

    fn interface(state: LyricsState) -> LyricsInterface {
        LyricsInterface {
            state: Arc::new(StdMutex::new(state)),
        }
    }

    fn set_document(interface: &LyricsInterface, document: DbusLyricsDocument) {
        let json = lyrics_json(Some(&document)).unwrap();
        let mut state = lock(&interface.state);
        state.lyrics = Some(document);
        state.lyrics_json = json;
    }

    fn parse_line(json: &str) -> serde_json::Value {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn interface_name_is_stable() {
        assert_eq!(LyricsInterface::name(), LYRICS_INTERFACE);
    }

    #[test]
    fn introspection_lists_the_public_contract() {
        let interface = interface(LyricsState::default());
        let mut xml = String::new();
        interface.introspect_to_writer(&mut xml, 0);

        for expected in [
            "<interface name=\"io.github.yucling.OpenOrpheus.Lyrics\">",
            "<method name=\"GetLyrics\">",
            "<method name=\"GetLineAt\">",
            "<property name=\"Available\" type=\"b\" access=\"read\"/>",
            "<property name=\"Slogan\" type=\"s\" access=\"read\"/>",
            "<property name=\"TrackId\" type=\"s\" access=\"read\"/>",
            "<property name=\"Title\" type=\"s\" access=\"read\"/>",
            "<property name=\"Artist\" type=\"s\" access=\"read\"/>",
            "<property name=\"Album\" type=\"s\" access=\"read\"/>",
            "<property name=\"Duration\" type=\"x\" access=\"read\"/>",
            "<property name=\"HasPerWord\" type=\"b\" access=\"read\"/>",
            "<property name=\"HasTranslation\" type=\"b\" access=\"read\"/>",
            "<property name=\"HasRoma\" type=\"b\" access=\"read\"/>",
            "<signal name=\"LyricsChanged\">",
            "<signal name=\"TrackChanged\">",
        ] {
            assert!(
                xml.contains(expected),
                "introspection is missing {expected}:\n{xml}"
            );
        }
    }

    #[test]
    fn get_lyrics_returns_null_without_lyrics() {
        let interface = interface(LyricsState::default());
        assert_eq!(interface.get_lyrics().unwrap(), "null");
    }

    #[test]
    fn get_lyrics_serializes_the_store_schema() {
        let interface = interface(LyricsState::default());
        set_document(&interface, document());

        let value: serde_json::Value =
            serde_json::from_str(&interface.get_lyrics().unwrap()).unwrap();
        let regular = value["regular"].as_array().unwrap();
        assert_eq!(regular.len(), 2);
        assert_eq!(regular[0]["words"][0]["text"], "hello");
        assert_eq!(regular[0]["start_time"], 0.0);
        assert!(value["translate"].is_array());
        assert!(value.get("per-word").is_none());
        assert!(value.get("roma").is_none());
    }

    #[test]
    fn get_line_at_returns_null_before_the_first_line() {
        let interface = interface(LyricsState::default());
        set_document(&interface, document());

        assert_eq!(interface.get_line_at(-1).unwrap(), "null");
    }

    #[test]
    fn get_line_at_finds_the_current_line() {
        let interface = interface(LyricsState::default());
        set_document(&interface, document());

        let value = parse_line(&interface.get_line_at(2_500).unwrap());
        assert_eq!(value["index"], 0);
        assert_eq!(value["text"], "hello");
        assert_eq!(value["translation"], "你好");
        assert!(value["roma"].is_null());

        let value = parse_line(&interface.get_line_at(5_000).unwrap());
        assert_eq!(value["index"], 1);
        assert_eq!(value["text"], "world");
        assert_eq!(value["translation"], "世界");
    }

    #[test]
    fn get_line_at_keeps_the_last_line_after_it_ends() {
        let interface = interface(LyricsState::default());
        set_document(&interface, document());

        let value = parse_line(&interface.get_line_at(60_000).unwrap());
        assert_eq!(value["index"], 1);
        assert_eq!(value["text"], "world");
    }

    #[test]
    fn get_line_at_prefers_per_word_lines() {
        let interface = interface(LyricsState::default());
        let mut document = document();
        document.per_word = Some(vec![DbusLyricsLine {
            start_time: 0.0,
            end_time: 5_000.0,
            words: vec![word("he", 0.0, 2_000.0), word("llo", 2_000.0, 3_000.0)],
        }]);
        set_document(&interface, document);

        let value = parse_line(&interface.get_line_at(100).unwrap());
        assert_eq!(value["text"], "hello");
        assert_eq!(value["words"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn translation_is_omitted_in_a_gap() {
        let interface = interface(LyricsState::default());
        let mut document = document();
        document.translate = Some(vec![
            line(0.0, 1_000.0, "first"),
            line(5_000.0, 6_000.0, "second"),
        ]);
        set_document(&interface, document);

        let value = parse_line(&interface.get_line_at(2_500).unwrap());
        assert!(value["translation"].is_null());
    }

    #[test]
    fn properties_follow_the_state() {
        let interface = interface(LyricsState::default());
        assert!(!interface.available());
        assert_eq!(interface.slogan(), "");
        assert_eq!(interface.track_id(), "");
        assert_eq!(interface.duration(), 0);

        set_document(&interface, document());
        assert!(interface.available());
        assert!(interface.has_translation());
        assert!(!interface.has_per_word());
        assert!(!interface.has_roma());

        lock(&interface.state).slogan = Some("slogan".to_string());
        assert_eq!(interface.slogan(), "slogan");

        lock(&interface.state).track = Some(DbusLyricsTrack {
            id: "1".to_string(),
            title: "title".to_string(),
            artist: "artist".to_string(),
            album: "album".to_string(),
            duration: Some(12_345.6),
        });
        assert_eq!(interface.track_id(), "1");
        assert_eq!(interface.title(), "title");
        assert_eq!(interface.artist(), "artist");
        assert_eq!(interface.album(), "album");
        assert_eq!(interface.duration(), 12_346);
    }

    #[test]
    fn line_lookup_handles_empty_inputs() {
        assert_eq!(index_at(&[], 0.0), None);
        assert_eq!(overlap_at(&[], 0.0), None);
    }

    #[test]
    fn introspection_snapshot_is_current() {
        let interface = interface(LyricsState::default());
        let mut xml = String::new();
        xml.push_str("<node name=\"/io/github/yucling/OpenOrpheus/Lyrics\">\n");
        interface.introspect_to_writer(&mut xml, 1);
        xml.push_str("</node>\n");

        let expected = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/resources/dbus/io.github.yucling.OpenOrpheus.Lyrics.xml"
        ));
        assert_eq!(
            expected, xml,
            "the checked-in introspection snapshot is stale"
        );
    }
}
