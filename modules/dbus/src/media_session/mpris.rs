use std::sync::{Arc, Mutex as StdMutex};

use napi_derive::napi;
use zbus::{
    fdo::Error,
    interface,
    object_server::{InterfaceRef, SignalEmitter},
    zvariant::{DeserializeDict, ObjectPath, OwnedObjectPath, SerializeDict, Type, Value},
    Connection,
};

use crate::media_session::{lock, EventDispatcher, MediaSessionEvents, PlaybackStatus};

const NO_TRACK_OBJECT_PATH: &str = "/org/mpris/MediaPlayer2/TrackList/NoTrack";

#[napi(object)]
pub struct PlaybackState {
    pub status: PlaybackStatus,
    pub position: i64,
    pub speed: Option<f64>,
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
    pub playback_state: Option<PlaybackState>,
    pub metadata: Option<MprisMetadata>,
}

impl PlayerState {
    pub fn new() -> Self {
        Self {
            volume: 1.0,
            playback_state: None,
            metadata: None,
        }
    }
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

#[derive(Default, Clone, DeserializeDict, SerializeDict, Type, Value)]
#[zvariant(signature = "dict")]
#[napi(object)]
pub struct MprisMetadata {
    #[zvariant(rename = "mpris:trackid")]
    pub track_id: String,
    #[zvariant(rename = "mpris:length")]
    pub length: Option<i64>,
    #[zvariant(rename = "mpris:artUrl")]
    pub art_url: Option<String>,
    #[zvariant(rename = "xesam:album")]
    pub album: Option<String>,
    #[zvariant(rename = "xesam:albumArtist")]
    pub album_artist: Option<Vec<String>>,
    #[zvariant(rename = "xesam:artist")]
    pub artist: Option<Vec<String>>,
    #[zvariant(rename = "xesam:asText")]
    pub lyrics: Option<String>,
    #[zvariant(rename = "xesam:title")]
    pub title: Option<String>,
}

/// D-Bus-facing metadata dict.
///
/// Kept separate from `MprisMetadata` because that type doubles as the NAPI
/// (TS ↔ Rust) boundary, where `track_id` must stay a plain string. Here
/// `mpris:trackid` must serialize as D-Bus type `o` (object path) per the
/// MPRIS spec.
#[derive(SerializeDict, Type, Value)]
#[zvariant(signature = "dict")]
pub struct MprisMetadataDict {
    #[zvariant(rename = "mpris:trackid")]
    pub track_id: OwnedObjectPath,
    #[zvariant(rename = "mpris:length")]
    pub length: Option<i64>,
    #[zvariant(rename = "mpris:artUrl")]
    pub art_url: Option<String>,
    #[zvariant(rename = "xesam:album")]
    pub album: Option<String>,
    #[zvariant(rename = "xesam:albumArtist")]
    pub album_artist: Option<Vec<String>>,
    #[zvariant(rename = "xesam:artist")]
    pub artist: Option<Vec<String>>,
    #[zvariant(rename = "xesam:asText")]
    pub lyrics: Option<String>,
    #[zvariant(rename = "xesam:title")]
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

    #[zbus(property)]
    async fn loop_status(&self) -> String {
        "Playlist".to_string()
    }

    #[zbus(property)]
    async fn rate(&self) -> f64 {
        lock(&self.state)
            .playback_state
            .as_ref()
            .and_then(|x| x.speed)
            .unwrap_or(1.0)
    }

    #[zbus(property)]
    async fn shuffle(&self) -> bool {
        // TODO: We aren't able to get it from NCM
        false
    }

    #[zbus(property)]
    async fn metadata(&self) -> MprisMetadataDict {
        lock(&self.state)
            .metadata
            .as_ref()
            .map(MprisMetadataDict::from)
            .unwrap_or_else(MprisMetadataDict::no_track)
    }

    #[zbus(property)]
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
        lock(&self.state)
            .playback_state
            .as_ref()
            .map(|x| x.position)
            .unwrap_or(0)
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
        state.metadata = metadata;
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

/// Replace the volume and emit `PropertiesChanged`.
pub async fn update_volume(
    conn: &Connection,
    state: &Arc<StdMutex<PlayerState>>,
    volume: f64,
) -> Result<(), String> {
    let iface_ref = player_interface(conn).await?;
    let iface = iface_ref.get().await;

    // The state lock is released before the signal is emitted: the generated
    // `volume_changed` calls the property getter, which takes the same lock.
    lock(state).volume = volume;

    iface
        .volume_changed(iface_ref.signal_emitter())
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
        let mut state = lock(state);
        let was_available = state.playback_state.is_some();
        let prev_status = state.playback_state.as_ref().map(|x| x.status);
        let prev_speed = state.playback_state.as_ref().and_then(|x| x.speed);
        let new_status = playback_state.as_ref().map(|x| x.status);
        let new_speed = playback_state.as_ref().and_then(|x| x.speed);

        state.playback_state = playback_state;
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
