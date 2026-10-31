use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Instant;

use napi_derive::napi;
use zbus::{
    fdo::Error,
    interface,
    names::InterfaceName,
    object_server::{InterfaceRef, SignalEmitter},
    Connection, DeserializeDict, ObjectPath, OwnedObjectPath, SerializeDict, Type, Variant,
};

use crate::media_session::{lock, EventDispatcher, MediaSessionEvents, PlaybackStatus};

const NO_TRACK_OBJECT_PATH: &str = "/org/mpris/MediaPlayer2/TrackList/NoTrack";

#[napi(object)]
pub struct PlaybackState {
    pub status: PlaybackStatus,
    /// Position in microseconds at the moment this update was produced.
    pub position: i64,
    pub speed: Option<f64>,
    /// Whether the position is currently advancing. Defaults to
    /// `status == Playing`; `false` freezes the reported position during
    /// buffering stalls without changing the MPRIS playback status.
    pub advancing: Option<bool>,
    /// True when `position` comes from a seek and is authoritative even if the
    /// previous clock was paused. Defaults to `false`.
    pub seeked: Option<bool>,
}

/// Mutable MPRIS properties.
///
/// These live behind their own lock rather than in `&mut self` fields on
/// purpose. zbus holds a *read* lock on an interface for the whole duration of
/// every `&self` method — including the wait for JS that a command does — so
/// anything that writes a property (the JS side calling `setVolume`,
/// `updatePlaybackState`, …) must reach the state without asking zbus for the
/// interface's write lock. A write lock there would deadlock against an
/// in-flight command that is waiting for the very JS call trying to take it.
pub struct PlayerState {
    pub volume: f64,
    pub loop_status: String,
    pub shuffle: bool,
    pub playback_state: Option<PlaybackState>,
    /// When `playback_state.position` was sampled. MPRIS `Position` is
    /// interpolated from this anchor so clients polling between the 1 Hz
    /// updates see the current position instead of a stale staircase.
    pub playback_updated_at: Instant,
    pub metadata: Option<MprisMetadata>,
}

impl PlayerState {
    pub fn new() -> Self {
        Self {
            volume: 1.0,
            loop_status: "None".to_string(),
            shuffle: false,
            playback_state: None,
            playback_updated_at: Instant::now(),
            metadata: None,
        }
    }

    /// The position at `now`, extrapolated from the last anchor.
    ///
    /// `advancing` is deliberately separate from `status`: a buffering stall
    /// keeps MPRIS `PlaybackStatus` as `Playing` while the position must stand
    /// still. The last known position is returned when the clock is frozen.
    fn position_at(&self, now: Instant) -> i64 {
        let Some(playback) = self.playback_state.as_ref() else {
            return 0;
        };

        let advancing = playback
            .advancing
            .unwrap_or(playback.status == PlaybackStatus::Playing);
        let raw_position = if advancing {
            let speed = playback.speed.unwrap_or(1.0);
            let elapsed = now
                .saturating_duration_since(self.playback_updated_at)
                .as_secs_f64();
            playback.position as f64 + elapsed * speed * 1_000_000.0
        } else {
            playback.position as f64
        };

        let position = raw_position.max(0.0).round() as i64;
        match self.metadata.as_ref().and_then(|metadata| metadata.length) {
            Some(length) if length >= 0 => position.min(length),
            _ => position,
        }
    }
}

/// Merge a new playback update with the previous clock.
///
/// The incoming `position` is only a synchronization point: it is used for a
/// periodic update while playing, or when the caller explicitly seeks. Pause,
/// rate changes, stalls, and resume must start from the position the previous
/// clock had reached at `now`, because the incoming position is then stale by
/// up to one update interval.
fn anchored_playback_state(
    previous: Option<&PlaybackState>,
    previous_position_at_now: i64,
    mut incoming: PlaybackState,
) -> PlaybackState {
    let seeked = incoming.seeked.unwrap_or(false);
    let status = incoming.status;
    let speed = incoming.speed.unwrap_or(1.0);
    let advancing = status == PlaybackStatus::Playing && incoming.advancing.unwrap_or(true);

    let previous_playing = previous.is_some_and(|state| state.status == PlaybackStatus::Playing);
    let previous_advancing = previous.is_some_and(|state| {
        state
            .advancing
            .unwrap_or(state.status == PlaybackStatus::Playing)
    });
    let previous_speed = previous.and_then(|state| state.speed).unwrap_or(1.0);

    // A normal position update while the clock is running. Seeks are also
    // authoritative because the caller knows the discontinuity happened.
    let is_periodic_sync = previous_playing
        && previous_advancing
        && status == PlaybackStatus::Playing
        && advancing
        && (speed - previous_speed).abs() < f64::EPSILON;

    let position = if seeked || previous.is_none() || is_periodic_sync {
        incoming.position
    } else {
        previous_position_at_now
    };

    incoming.position = position;
    incoming.speed = Some(speed);
    incoming.advancing = Some(advancing);
    incoming.seeked = None;
    incoming
}

pub struct Interface {
    pub dispatcher: EventDispatcher,
    pub identity: String,
    pub desktop_entry: String,
}

impl Interface {
    async fn dispatch(&self, event: MediaSessionEvents) -> Result<(), Error> {
        self.dispatcher.dispatch(event).await.map_err(Error::Failed)
    }
}

#[interface(name = "org.mpris.MediaPlayer2")]
impl Interface {
    async fn raise(&self) -> Result<(), Error> {
        self.dispatch(MediaSessionEvents::Raise).await
    }

    async fn quit(&self) -> Result<(), Error> {
        self.dispatch(MediaSessionEvents::Quit).await
    }

    #[zbus(property)]
    fn can_quit(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn fullscreen(&self) -> bool {
        false
    }

    #[zbus(property)]
    fn set_fullscreen(&self, _fullscreen: bool) -> Result<(), Error> {
        Err(zbus::fdo::Error::NotSupported(
            "Setting fullscreen is not supported".to_string(),
        ))
    }

    #[zbus(property)]
    fn can_set_fullscreen(&self) -> bool {
        false
    }

    #[zbus(property)]
    fn can_raise(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn has_track_list(&self) -> bool {
        // TODO: Track list support
        false
    }

    #[zbus(property)]
    fn identity(&self) -> String {
        self.identity.clone()
    }

    #[zbus(property)]
    fn desktop_entry(&self) -> String {
        self.desktop_entry.clone()
    }

    #[zbus(property)]
    fn supported_uri_schemes(&self) -> Vec<String> {
        vec![]
    }

    #[zbus(property)]
    fn supported_mime_types(&self) -> Vec<String> {
        vec![]
    }
}

#[derive(Default, Clone, DeserializeDict, SerializeDict, Type, Variant)]
#[zbus(signature = "dict")]
#[napi(object)]
pub struct MprisMetadata {
    #[zbus(rename = "mpris:trackid")]
    pub track_id: String,
    #[zbus(rename = "mpris:length")]
    pub length: Option<i64>,
    #[zbus(rename = "mpris:artUrl")]
    pub art_url: Option<String>,
    #[zbus(rename = "xesam:album")]
    pub album: Option<String>,
    #[zbus(rename = "xesam:albumArtist")]
    pub album_artist: Option<Vec<String>>,
    #[zbus(rename = "xesam:artist")]
    pub artist: Option<Vec<String>>,
    #[zbus(rename = "xesam:asText")]
    pub lyrics: Option<String>,
    #[zbus(rename = "xesam:title")]
    pub title: Option<String>,
}

/// D-Bus-facing metadata dict.
///
/// Kept separate from `MprisMetadata` because that type doubles as the NAPI
/// (TS ↔ Rust) boundary, where `track_id` must stay a plain string. Here
/// `mpris:trackid` must serialize as D-Bus type `o` (object path) per the
/// MPRIS spec.
#[derive(SerializeDict, Type, Variant)]
#[zbus(signature = "dict")]
pub struct MprisMetadataDict {
    #[zbus(rename = "mpris:trackid")]
    pub track_id: OwnedObjectPath,
    #[zbus(rename = "mpris:length")]
    pub length: Option<i64>,
    #[zbus(rename = "mpris:artUrl")]
    pub art_url: Option<String>,
    #[zbus(rename = "xesam:album")]
    pub album: Option<String>,
    #[zbus(rename = "xesam:albumArtist")]
    pub album_artist: Option<Vec<String>>,
    #[zbus(rename = "xesam:artist")]
    pub artist: Option<Vec<String>>,
    #[zbus(rename = "xesam:asText")]
    pub lyrics: Option<String>,
    #[zbus(rename = "xesam:title")]
    pub title: Option<String>,
}

impl MprisMetadataDict {
    fn no_track() -> Self {
        Self {
            track_id: object_path(NO_TRACK_OBJECT_PATH),
            length: None,
            art_url: None,
            album: None,
            album_artist: None,
            artist: None,
            lyrics: None,
            title: None,
        }
    }
}

impl From<&MprisMetadata> for MprisMetadataDict {
    fn from(metadata: &MprisMetadata) -> Self {
        Self {
            track_id: object_path(&metadata.track_id),
            length: metadata.length,
            art_url: metadata.art_url.clone(),
            album: metadata.album.clone(),
            album_artist: metadata.album_artist.clone(),
            artist: metadata.artist.clone(),
            lyrics: metadata.lyrics.clone(),
            title: metadata.title.clone(),
        }
    }
}

/// Build an owned object path, falling back to `NoTrack` for invalid paths.
fn object_path(path: &str) -> OwnedObjectPath {
    match ObjectPath::try_from(path) {
        Ok(p) => OwnedObjectPath::from(p),
        Err(_) => OwnedObjectPath::from(ObjectPath::from_str_unchecked(NO_TRACK_OBJECT_PATH)),
    }
}

pub struct PlayerInterface {
    pub dispatcher: EventDispatcher,
    pub state: Arc<StdMutex<PlayerState>>,
}

impl PlayerInterface {
    async fn dispatch(&self, event: MediaSessionEvents) -> Result<(), Error> {
        self.dispatcher.dispatch(event).await.map_err(Error::Failed)
    }
}

#[interface(name = "org.mpris.MediaPlayer2.Player")]
impl PlayerInterface {
    async fn next(&self) -> Result<(), Error> {
        self.dispatch(MediaSessionEvents::Next).await
    }

    async fn previous(&self) -> Result<(), Error> {
        self.dispatch(MediaSessionEvents::Previous).await
    }

    async fn pause(&self) -> Result<(), Error> {
        self.dispatch(MediaSessionEvents::Pause).await
    }

    async fn play(&self) -> Result<(), Error> {
        self.dispatch(MediaSessionEvents::Play).await
    }

    async fn play_pause(&self) -> Result<(), Error> {
        let status = lock(&self.state).playback_state.as_ref().map(|x| x.status);
        let Some(status) = status else {
            return Err(zbus::fdo::Error::Failed("No playback".to_string()));
        };
        if status == PlaybackStatus::Playing {
            self.pause().await
        } else {
            self.play().await
        }
    }

    fn stop(&self) {
        // TODO: No effect?
    }

    async fn seek(&self, offset: i64) -> Result<(), Error> {
        self.dispatch(MediaSessionEvents::Seek { delta: offset })
            .await
    }

    async fn set_position(&self, track_id: OwnedObjectPath, position: i64) -> Result<(), Error> {
        let is_current_track = lock(&self.state)
            .metadata
            .as_ref()
            .is_some_and(|metadata| metadata.track_id == track_id.as_str());
        if !is_current_track {
            return Ok(());
        }
        self.dispatch(MediaSessionEvents::SetPosition { position })
            .await
    }

    #[zbus(property)]
    async fn playback_status(&self) -> String {
        let status = lock(&self.state).playback_state.as_ref().map(|x| x.status);
        match status {
            Some(PlaybackStatus::Playing) => "Playing",
            Some(PlaybackStatus::Paused) => "Paused",
            _ => "Stopped",
        }
        .to_string()
    }

    #[zbus(property(emits_changed_signal = "false"))]
    async fn loop_status(&self) -> String {
        lock(&self.state).loop_status.clone()
    }

    #[zbus(property)]
    async fn set_loop_status(&self, loop_status: String) -> Result<(), Error> {
        validate_loop_status(&loop_status)?;
        self.dispatch(MediaSessionEvents::SetLoopStatus { loop_status })
            .await
    }

    #[zbus(property)]
    async fn rate(&self) -> f64 {
        lock(&self.state)
            .playback_state
            .as_ref()
            .and_then(|x| x.speed)
            .unwrap_or(1.0)
    }

    #[zbus(property(emits_changed_signal = "false"))]
    async fn shuffle(&self) -> bool {
        lock(&self.state).shuffle
    }

    #[zbus(property)]
    async fn set_shuffle(&self, shuffle: bool) -> Result<(), Error> {
        self.dispatch(MediaSessionEvents::SetShuffle { shuffle })
            .await
    }

    #[zbus(property)]
    async fn metadata(&self) -> MprisMetadataDict {
        lock(&self.state)
            .metadata
            .as_ref()
            .map(MprisMetadataDict::from)
            .unwrap_or_else(MprisMetadataDict::no_track)
    }

    #[zbus(property(emits_changed_signal = "false"))]
    fn volume(&self) -> f64 {
        lock(&self.state).volume
    }

    #[zbus(property)]
    async fn set_volume(&self, volume: f64) -> Result<(), Error> {
        self.dispatch(MediaSessionEvents::SetVolume { volume })
            .await
    }

    #[zbus(property)]
    async fn position(&self) -> i64 {
        lock(&self.state).position_at(Instant::now())
    }

    #[zbus(property)]
    async fn minimum_rate(&self) -> f64 {
        1.0
    }
    #[zbus(property)]
    async fn maximum_rate(&self) -> f64 {
        1.0
    }

    #[zbus(property)]
    async fn can_go_next(&self) -> bool {
        lock(&self.state).metadata.is_some()
    }

    #[zbus(property)]
    async fn can_go_previous(&self) -> bool {
        lock(&self.state).metadata.is_some()
    }

    #[zbus(property)]
    async fn can_play(&self) -> bool {
        lock(&self.state).metadata.is_some()
    }

    #[zbus(property)]
    async fn can_pause(&self) -> bool {
        lock(&self.state).metadata.is_some()
    }

    #[zbus(property)]
    async fn can_seek(&self) -> bool {
        lock(&self.state).metadata.is_some()
    }

    #[zbus(property)]
    async fn can_control(&self) -> bool {
        true
    }

    #[zbus(signal)]
    async fn seeked(emitter: &SignalEmitter<'_>, time: i64) -> zbus::Result<()>;
}

/// Look up the player interface on the connection.
async fn player_interface(conn: &Connection) -> Result<InterfaceRef<PlayerInterface>, String> {
    conn.object_server()
        .interface::<_, PlayerInterface>(super::MPRIS_OBJECT_PATH)
        .await
        .map_err(|e| e.to_string())
}

/// Replace the MPRIS metadata and emit the matching `PropertiesChanged`
/// signals, including the `Can*` properties whose availability it drives.
pub async fn update_metadata(
    conn: &Connection,
    state: &Arc<StdMutex<PlayerState>>,
    metadata: Option<MprisMetadata>,
) -> Result<(), String> {
    let iface_ref = player_interface(conn).await?;
    // A read guard, never `get_mut()`: a command dispatched by zbus may be
    // parked on this interface's read lock while it waits for JS, and that JS
    // is exactly what calls this function.
    let iface = iface_ref.get().await;
    let emitter = iface_ref.signal_emitter();

    let (metadata_was_available, metadata_is_available) = {
        let mut state = lock(state);
        let was_available = state.metadata.is_some();
        let track_changed = state
            .metadata
            .as_ref()
            .map(|metadata| metadata.track_id.as_str())
            != metadata.as_ref().map(|metadata| metadata.track_id.as_str());

        state.metadata = metadata;
        if track_changed {
            // A new track starts at zero. Keeping the previous song's anchor
            // would report the old position until the next 1 Hz update.
            if let Some(playback) = state.playback_state.as_mut() {
                playback.position = 0;
            }
            state.playback_updated_at = Instant::now();
        }

        (was_available, state.metadata.is_some())
    };

    if metadata_was_available != metadata_is_available {
        iface
            .can_go_next_changed(emitter)
            .await
            .map_err(|e| e.to_string())?;
        iface
            .can_go_previous_changed(emitter)
            .await
            .map_err(|e| e.to_string())?;
        iface
            .can_play_changed(emitter)
            .await
            .map_err(|e| e.to_string())?;
        iface
            .can_pause_changed(emitter)
            .await
            .map_err(|e| e.to_string())?;
        iface
            .can_seek_changed(emitter)
            .await
            .map_err(|e| e.to_string())?;
    }

    iface
        .metadata_changed(emitter)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Emit the single `PropertiesChanged` for `Volume`.
async fn emit_volume_changed(emitter: &SignalEmitter<'_>, volume: f64) -> Result<(), String> {
    let mut changed = HashMap::new();
    changed.insert("Volume", Variant::from(volume));

    zbus::fdo::Properties::properties_changed(
        emitter,
        InterfaceName::from_static_str_unchecked("org.mpris.MediaPlayer2.Player"),
        changed,
        Cow::Borrowed(&[]),
    )
    .await
    .map_err(|e| e.to_string())
}

/// Replace the volume and emit `PropertiesChanged`.
pub async fn update_volume(
    conn: &Connection,
    state: &Arc<StdMutex<PlayerState>>,
    volume: f64,
) -> Result<(), String> {
    let iface_ref = player_interface(conn).await?;

    // The state lock is released before the signal is emitted. Emitting needs
    // only the emitter, so no interface guard is held either.
    lock(state).volume = volume;

    emit_volume_changed(iface_ref.signal_emitter(), volume).await
}

fn validate_loop_status(loop_status: &str) -> Result<(), Error> {
    match loop_status {
        "None" | "Track" | "Playlist" => Ok(()),
        _ => Err(Error::InvalidArgs(format!(
            "Invalid LoopStatus: {loop_status}"
        ))),
    }
}

/// Publish the renderer-confirmed mode as one diff, since the native player
/// can change both properties together (e.g. single-track repeat exits shuffle).
pub async fn update_playback_mode(
    conn: &Connection,
    state: &Arc<StdMutex<PlayerState>>,
    loop_status: String,
    shuffle: bool,
) -> Result<(), String> {
    validate_loop_status(&loop_status).map_err(|e| e.to_string())?;
    let iface_ref = player_interface(conn).await?;
    let mut changed = HashMap::new();
    {
        let mut state = lock(state);
        if state.loop_status != loop_status {
            state.loop_status = loop_status.clone();
            changed.insert("LoopStatus", Variant::from(loop_status));
        }
        if state.shuffle != shuffle {
            state.shuffle = shuffle;
            changed.insert("Shuffle", Variant::from(shuffle));
        }
    }
    if changed.is_empty() {
        return Ok(());
    }
    // Like Volume, updates must not acquire the interface write lock while a
    // Properties.Set request is waiting for the JS handler's confirmation.
    zbus::fdo::Properties::properties_changed(
        iface_ref.signal_emitter(),
        InterfaceName::from_static_str_unchecked("org.mpris.MediaPlayer2.Player"),
        changed,
        Cow::Borrowed(&[]),
    )
    .await
    .map_err(|e| e.to_string())
}

/// Replace the playback state and emit the signals its diff implies.
pub async fn update_playback_state(
    conn: &Connection,
    state: &Arc<StdMutex<PlayerState>>,
    playback_state: Option<PlaybackState>,
) -> Result<(), String> {
    let iface_ref = player_interface(conn).await?;
    let iface = iface_ref.get().await;
    let emitter = iface_ref.signal_emitter();

    let (state_was_available, state_is_available, prev_status, new_status, prev_speed, new_speed) = {
        let now = Instant::now();
        let mut state = lock(state);
        let previous_position_at_now = state.position_at(now);
        let was_available = state.playback_state.is_some();
        let prev_status = state.playback_state.as_ref().map(|x| x.status);
        let prev_speed = state.playback_state.as_ref().and_then(|x| x.speed);

        let next = playback_state.map(|incoming| {
            anchored_playback_state(
                state.playback_state.as_ref(),
                previous_position_at_now,
                incoming,
            )
        });
        let new_status = next.as_ref().map(|x| x.status);
        let new_speed = next.as_ref().and_then(|x| x.speed);

        state.playback_state = next;
        state.playback_updated_at = now;
        (
            was_available,
            state.playback_state.is_some(),
            prev_status,
            new_status,
            prev_speed,
            new_speed,
        )
    };

    if state_was_available != state_is_available {
        iface
            .can_play_changed(emitter)
            .await
            .map_err(|e| e.to_string())?;
        iface
            .can_pause_changed(emitter)
            .await
            .map_err(|e| e.to_string())?;
    }

    if prev_status != new_status {
        iface
            .playback_status_changed(emitter)
            .await
            .map_err(|e| e.to_string())?;
    }

    if prev_speed != new_speed {
        iface
            .rate_changed(emitter)
            .await
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

pub async fn send_seeked(conn: &Connection, time: i64) -> Result<(), String> {
    player_interface(conn)
        .await?
        .seeked(time)
        .await
        .map_err(|e| e.to_string())
}

#[allow(dead_code)]
pub struct TrackListInterface {}

#[interface(name = "org.mpris.MediaPlayer2.TrackList")]
impl TrackListInterface {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn playback(
        status: PlaybackStatus,
        position: i64,
        speed: f64,
        advancing: bool,
    ) -> PlaybackState {
        PlaybackState {
            status,
            position,
            speed: Some(speed),
            advancing: Some(advancing),
            seeked: None,
        }
    }

    fn player_state(playback: PlaybackState, elapsed: Duration) -> PlayerState {
        PlayerState {
            volume: 1.0,
            loop_status: "None".to_string(),
            shuffle: false,
            playback_state: Some(playback),
            playback_updated_at: Instant::now() - elapsed,
            metadata: None,
        }
    }

    #[test]
    fn position_interpolates_while_playing() {
        let state = player_state(
            playback(PlaybackStatus::Playing, 1_000_000, 1.0, true),
            Duration::from_millis(500),
        );

        let position = state.position_at(Instant::now());
        assert!(
            (position - 1_500_000).abs() < 20_000,
            "expected about 1.5 s, got {position} µs"
        );
    }

    #[test]
    fn position_freezes_when_paused() {
        let state = player_state(
            playback(PlaybackStatus::Paused, 1_000_000, 1.0, false),
            Duration::from_secs(2),
        );

        assert_eq!(state.position_at(Instant::now()), 1_000_000);
    }

    #[test]
    fn position_freezes_when_not_advancing() {
        let state = player_state(
            // A buffering stall keeps the MPRIS status as Playing.
            playback(PlaybackStatus::Playing, 1_000_000, 1.0, false),
            Duration::from_secs(2),
        );

        assert_eq!(state.position_at(Instant::now()), 1_000_000);
    }

    #[test]
    fn position_respects_playback_rate() {
        let state = player_state(
            playback(PlaybackStatus::Playing, 1_000_000, 2.0, true),
            Duration::from_millis(500),
        );

        let position = state.position_at(Instant::now());
        assert!(
            (position - 2_000_000).abs() < 20_000,
            "expected about 2 s, got {position} µs"
        );
    }

    #[test]
    fn position_clamps_to_track_length() {
        let mut state = player_state(
            playback(PlaybackStatus::Playing, 1_000_000, 1.0, true),
            Duration::from_millis(500),
        );
        state.metadata = Some(MprisMetadata {
            length: Some(1_200_000),
            ..Default::default()
        });

        assert_eq!(state.position_at(Instant::now()), 1_200_000);
    }

    #[test]
    fn position_is_zero_without_playback() {
        assert_eq!(PlayerState::new().position_at(Instant::now()), 0);
    }

    #[test]
    fn periodic_update_uses_incoming_position() {
        let previous = playback(PlaybackStatus::Playing, 1_000_000, 1.0, true);
        let incoming = playback(PlaybackStatus::Playing, 1_500_000, 1.0, true);

        let next = anchored_playback_state(Some(&previous), 1_400_000, incoming);
        assert_eq!(next.position, 1_500_000);
        assert_eq!(next.advancing, Some(true));
        assert_eq!(next.seeked, None);
    }

    #[test]
    fn pause_uses_the_previous_clock_position() {
        let previous = playback(PlaybackStatus::Playing, 1_000_000, 1.0, true);
        // The adapter's cached position is stale at pause time.
        let incoming = playback(PlaybackStatus::Paused, 1_000_000, 1.0, false);

        let next = anchored_playback_state(Some(&previous), 1_600_000, incoming);
        assert_eq!(next.position, 1_600_000);
        assert_eq!(next.advancing, Some(false));
    }

    #[test]
    fn seek_is_authoritative_even_when_paused() {
        let previous = playback(PlaybackStatus::Paused, 1_000_000, 1.0, false);
        let mut incoming = playback(PlaybackStatus::Paused, 30_000_000, 1.0, false);
        incoming.seeked = Some(true);

        let next = anchored_playback_state(Some(&previous), 1_000_000, incoming);
        assert_eq!(next.position, 30_000_000);
        assert_eq!(next.advancing, Some(false));
    }

    #[test]
    fn rate_change_uses_the_previous_clock_position() {
        let previous = playback(PlaybackStatus::Playing, 1_000_000, 1.0, true);
        // The adapter's cached position is stale when the rate changes.
        let incoming = playback(PlaybackStatus::Playing, 1_000_000, 2.0, true);

        let next = anchored_playback_state(Some(&previous), 1_700_000, incoming);
        assert_eq!(next.position, 1_700_000);
        assert_eq!(next.speed, Some(2.0));
    }

    #[test]
    fn stall_freezes_at_the_previous_clock_position() {
        let previous = playback(PlaybackStatus::Playing, 1_000_000, 1.0, true);
        let incoming = playback(PlaybackStatus::Playing, 1_000_000, 1.0, false);

        let next = anchored_playback_state(Some(&previous), 1_700_000, incoming);
        assert_eq!(next.position, 1_700_000);
        assert_eq!(next.advancing, Some(false));
    }

    #[test]
    fn resume_uses_the_frozen_previous_position() {
        let previous = playback(PlaybackStatus::Paused, 1_500_000, 1.0, false);
        let incoming = playback(PlaybackStatus::Playing, 1_400_000, 1.0, true);

        let next = anchored_playback_state(Some(&previous), 1_500_000, incoming);
        assert_eq!(next.position, 1_500_000);
        assert_eq!(next.advancing, Some(true));
    }

    #[test]
    fn first_update_uses_the_incoming_position() {
        let incoming = playback(PlaybackStatus::Playing, 1_500_000, 1.0, true);

        let next = anchored_playback_state(None, 0, incoming);
        assert_eq!(next.position, 1_500_000);
        assert_eq!(next.advancing, Some(true));
    }

    #[test]
    fn advancing_is_forced_off_when_not_playing() {
        let incoming = playback(PlaybackStatus::Paused, 1_000_000, 1.0, true);

        let next = anchored_playback_state(None, 0, incoming);
        assert_eq!(next.advancing, Some(false));
    }
}
