use napi_derive::napi;
use smol::channel::Sender;
use zbus::{
    fdo::Error,
    interface,
    object_server::SignalEmitter,
    zvariant::{DeserializeDict, OwnedObjectPath, SerializeDict, Type, Value},
};

use crate::media_session::{MediaSessionEvents, PlaybackStatus};

const NO_TRACK_OBJECT_PATH: &str = "/org/mpris/MediaPlayer2/TrackList/NoTrack";

#[napi(object)]
pub struct PlaybackState {
    pub status: PlaybackStatus,
    pub position: i64,
    pub speed: Option<f64>,
}

pub struct Interface {
    pub tx: Sender<MediaSessionEvents>,
    pub identity: String,
    pub desktop_entry: String,
}

#[interface(name = "org.mpris.MediaPlayer2")]
impl Interface {
    async fn raise(&mut self) -> Result<(), Error> {
        self.tx
            .send(MediaSessionEvents::Raise)
            .await
            .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))
    }

    async fn quit(&mut self) -> Result<(), Error> {
        self.tx
            .send(MediaSessionEvents::Quit)
            .await
            .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))
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

pub struct PlayerInterface {
    pub tx: Sender<MediaSessionEvents>,
    pub volume: f64,
    pub playback_state: Option<PlaybackState>,
    pub metadata: Option<MprisMetadata>,
}

#[interface(name = "org.mpris.MediaPlayer2.Player")]
impl PlayerInterface {
    async fn next(&self) -> Result<(), Error> {
        self.tx
            .send(MediaSessionEvents::Next)
            .await
            .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))
    }

    async fn previous(&self) -> Result<(), Error> {
        self.tx
            .send(MediaSessionEvents::Previous)
            .await
            .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))
    }

    async fn pause(&self) -> Result<(), Error> {
        self.tx
            .send(MediaSessionEvents::Pause)
            .await
            .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))
    }

    async fn play(&self) -> Result<(), Error> {
        self.tx
            .send(MediaSessionEvents::Play)
            .await
            .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))
    }

    async fn play_pause(&self) -> Result<(), Error> {
        let Some(playback_state) = &self.playback_state else {
            return Err(zbus::fdo::Error::Failed("No playback".to_string()));
        };
        if playback_state.status == PlaybackStatus::Playing {
            self.pause().await
        } else {
            self.play().await
        }
    }

    fn stop(&self) {
        // TODO: No effect?
    }

    async fn seek(&self, offset: i64) -> Result<(), Error> {
        self.tx
            .send(MediaSessionEvents::Seek { delta: offset })
            .await
            .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))
    }

    async fn set_position(&self, track_id: OwnedObjectPath, position: i64) -> Result<(), Error> {
        println!("set pos {} {}", track_id, position);
        let Some(metadata) = &self.metadata else {
            return Ok(());
        };
        println!("cur track {}", metadata.track_id);
        if metadata.track_id != track_id.as_str() {
            return Ok(());
        }
        self.tx
            .send(MediaSessionEvents::SetPosition { position })
            .await
            .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))
    }

    #[zbus(property)]
    async fn playback_status(&self) -> String {
        let Some(playback_state) = &self.playback_state else {
            return "Stopped".to_string();
        };
        match playback_state.status {
            PlaybackStatus::Playing => "Playing",
            PlaybackStatus::Paused => "Paused",
            PlaybackStatus::Stopped => "Stopped",
        }
        .to_string()
    }

    #[zbus(property)]
    async fn loop_status(&self) -> String {
        "Playlist".to_string()
    }

    #[zbus(property)]
    async fn rate(&self) -> f64 {
        let Some(playback_state) = &self.playback_state else {
            return 1.0;
        };
        playback_state.speed.unwrap_or(1.0)
    }

    #[zbus(property)]
    async fn shuffle(&self) -> bool {
        // TODO: We aren't able to get it from NCM
        false
    }

    #[zbus(property)]
    async fn metadata(&self) -> MprisMetadata {
        let Some(ref metadata) = self.metadata else {
            return MprisMetadata {
                track_id: NO_TRACK_OBJECT_PATH.to_string(),
                ..Default::default()
            };
        };
        metadata.clone()
    }

    #[zbus(property)]
    fn volume(&self) -> f64 {
        self.volume
    }

    #[zbus(property)]
    async fn set_volume(&self, volume: f64) -> Result<(), Error> {
        self.tx
            .send(MediaSessionEvents::SetVolume { volume })
            .await
            .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))
    }

    #[zbus(property)]
    async fn position(&self) -> i64 {
        let Some(ref playback_state) = &self.playback_state else {
            return 0;
        };
        playback_state.position
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
        true
    }

    #[zbus(property)]
    async fn can_go_previous(&self) -> bool {
        true
    }

    #[zbus(property)]
    async fn can_play(&self) -> bool {
        self.playback_state.is_some()
    }

    #[zbus(property)]
    async fn can_pause(&self) -> bool {
        self.playback_state.is_some()
    }

    #[zbus(property)]
    async fn can_seek(&self) -> bool {
        self.playback_state.is_some()
    }

    #[zbus(property)]
    async fn can_control(&self) -> bool {
        true
    }

    #[zbus(signal)]
    async fn seeked(emitter: &SignalEmitter<'_>, time: i64) -> zbus::Result<()>;
}

pub struct TrackListInterface {}

#[interface(name = "org.mpris.MediaPlayer2.TrackList")]
impl TrackListInterface {}
