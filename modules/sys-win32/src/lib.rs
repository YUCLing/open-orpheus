#![cfg(windows)] // Windows-only module (SMTC media session + power-off); see package.json "os".
#![deny(clippy::all)]

pub mod shutdown;

use std::sync::{Arc, Mutex};

use napi::{
    threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
    Error, Result,
};
use napi_derive::napi;
use windows::{
    core::{Ref, HSTRING},
    Foundation::{TimeSpan, TypedEventHandler, Uri},
    Media::Playback::MediaPlayer,
    Media::{
        MediaPlaybackStatus, MediaPlaybackType, PlaybackPositionChangeRequestedEventArgs,
        PlaybackRateChangeRequestedEventArgs, SystemMediaTransportControls,
        SystemMediaTransportControlsButton, SystemMediaTransportControlsButtonPressedEventArgs,
        SystemMediaTransportControlsTimelineProperties,
    },
    Storage::Streams::RandomAccessStreamReference,
};

#[napi]
pub enum MediaSessionEvents {
    Play,
    Pause,
    Next,
    Previous,
    Stop,
    SetPosition { position: i64 },
    SetRate { rate: f64 },
}

#[napi(object)]
pub struct SmtcMetadata {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub art_url: Option<String>,
}

#[napi]
pub struct MediaSession {
    // Kept alive for the lifetime of the session: the SMTC instance is owned by
    // the MediaPlayer, so dropping it would tear the transport controls down.
    _media_player: MediaPlayer,
    smtc: SystemMediaTransportControls,
    event_handler: Arc<Mutex<Option<ThreadsafeFunction<MediaSessionEvents, ()>>>>,
}

#[napi]
impl MediaSession {
    #[napi(constructor)]
    pub fn new() -> Result<Self> {
        let media_player = MediaPlayer::new().map_err(napi_err)?;

        // Drive the SMTC manually: disable the automatic command manager so the
        // system controls reflect *our* playback state rather than the player's.
        media_player
            .CommandManager()
            .map_err(napi_err)?
            .SetIsEnabled(false)
            .map_err(napi_err)?;

        let smtc = media_player
            .SystemMediaTransportControls()
            .map_err(napi_err)?;
        smtc.SetIsEnabled(true).map_err(napi_err)?;
        smtc.SetIsPlayEnabled(true).map_err(napi_err)?;
        smtc.SetIsPauseEnabled(true).map_err(napi_err)?;
        smtc.SetIsNextEnabled(true).map_err(napi_err)?;
        smtc.SetIsPreviousEnabled(true).map_err(napi_err)?;

        let event_handler: Arc<Mutex<Option<ThreadsafeFunction<MediaSessionEvents, ()>>>> =
            Arc::new(Mutex::new(None));

        let handler = event_handler.clone();
        smtc.ButtonPressed(&TypedEventHandler::new(
            move |_: Ref<SystemMediaTransportControls>,
                  args: Ref<SystemMediaTransportControlsButtonPressedEventArgs>| {
                let args = args.unwrap();
                let event = match args.Button()? {
                    SystemMediaTransportControlsButton::Play => MediaSessionEvents::Play,
                    SystemMediaTransportControlsButton::Pause => MediaSessionEvents::Pause,
                    SystemMediaTransportControlsButton::Next => MediaSessionEvents::Next,
                    SystemMediaTransportControlsButton::Previous => MediaSessionEvents::Previous,
                    SystemMediaTransportControlsButton::Stop => MediaSessionEvents::Stop,
                    _ => return Ok(()),
                };
                fire_event(&handler, event);
                Ok(())
            },
        ))
        .map_err(napi_err)?;

        let handler = event_handler.clone();
        smtc.PlaybackPositionChangeRequested(&TypedEventHandler::new(
            move |_: Ref<SystemMediaTransportControls>,
                  args: Ref<PlaybackPositionChangeRequestedEventArgs>| {
                fire_event(
                    &handler,
                    MediaSessionEvents::SetPosition {
                        position: args.unwrap().RequestedPlaybackPosition()?.Duration,
                    },
                );
                Ok(())
            },
        ))
        .map_err(napi_err)?;

        let handler = event_handler.clone();
        smtc.PlaybackRateChangeRequested(&TypedEventHandler::new(
            move |_: Ref<SystemMediaTransportControls>,
                  args: Ref<PlaybackRateChangeRequestedEventArgs>| {
                fire_event(
                    &handler,
                    MediaSessionEvents::SetRate {
                        rate: args.unwrap().RequestedPlaybackRate()?,
                    },
                );
                Ok(())
            },
        ))
        .map_err(napi_err)?;

        Ok(Self {
            _media_player: media_player,
            smtc,
            event_handler,
        })
    }

    #[napi]
    pub fn set_event_handler(&self, handler: Option<ThreadsafeFunction<MediaSessionEvents, ()>>) {
        *self.event_handler.lock().unwrap() = handler;
    }

    #[napi]
    pub fn set_metadata(&self, metadata: Option<SmtcMetadata>) -> Result<()> {
        let updater = self.smtc.DisplayUpdater().map_err(napi_err)?;
        updater
            .SetType(MediaPlaybackType::Music)
            .map_err(napi_err)?;
        let props = updater.MusicProperties().map_err(napi_err)?;

        let (title, artist, album, album_artist) = match &metadata {
            Some(metadata) => (
                metadata.title.clone().unwrap_or_default(),
                metadata.artist.clone().unwrap_or_default(),
                metadata.album.clone().unwrap_or_default(),
                metadata.album_artist.clone().unwrap_or_default(),
            ),
            // No track: clear the displayed metadata.
            None => Default::default(),
        };
        props.SetTitle(&HSTRING::from(title)).map_err(napi_err)?;
        props.SetArtist(&HSTRING::from(artist)).map_err(napi_err)?;
        props
            .SetAlbumTitle(&HSTRING::from(album))
            .map_err(napi_err)?;
        props
            .SetAlbumArtist(&HSTRING::from(album_artist))
            .map_err(napi_err)?;

        if let Some(metadata) = &metadata {
            if let Some(url) = &metadata.art_url {
                let uri = Uri::CreateUri(&HSTRING::from(url.as_str())).map_err(napi_err)?;
                let thumbnail =
                    RandomAccessStreamReference::CreateFromUri(&uri).map_err(napi_err)?;
                updater.SetThumbnail(Some(&thumbnail)).map_err(napi_err)?;
            }
        }

        updater.Update().map_err(napi_err)?;
        Ok(())
    }

    #[napi]
    pub fn set_playback_status(&self, status: String) -> Result<()> {
        let status = match status.as_str() {
            "playing" => MediaPlaybackStatus::Playing,
            "paused" => MediaPlaybackStatus::Paused,
            "stopped" => MediaPlaybackStatus::Stopped,
            _ => {
                return Err(Error::from_reason(format!(
                    "Unknown playback status: {status}"
                )))
            }
        };
        self.smtc.SetPlaybackStatus(status).map_err(napi_err)?;
        Ok(())
    }

    #[napi]
    pub fn set_playback_rate(&self, rate: f64) -> Result<()> {
        self.smtc.SetPlaybackRate(rate).map_err(napi_err)?;
        Ok(())
    }

    /// Update the SMTC timeline. Both values are in 100 ns ticks.
    #[napi]
    pub fn set_timeline_properties(&self, position: i64, duration: i64) -> Result<()> {
        let timeline = SystemMediaTransportControlsTimelineProperties::new().map_err(napi_err)?;
        timeline
            .SetStartTime(TimeSpan { Duration: 0 })
            .map_err(napi_err)?;
        timeline
            .SetEndTime(TimeSpan { Duration: duration })
            .map_err(napi_err)?;
        timeline
            .SetMinSeekTime(TimeSpan { Duration: 0 })
            .map_err(napi_err)?;
        timeline
            .SetMaxSeekTime(TimeSpan { Duration: duration })
            .map_err(napi_err)?;
        timeline
            .SetPosition(TimeSpan { Duration: position })
            .map_err(napi_err)?;
        self.smtc
            .UpdateTimelineProperties(&timeline)
            .map_err(napi_err)?;
        Ok(())
    }
}

fn fire_event(
    handler: &Mutex<Option<ThreadsafeFunction<MediaSessionEvents, ()>>>,
    event: MediaSessionEvents,
) {
    if let Some(handler) = handler.lock().unwrap().as_ref() {
        let _ = handler.call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
    }
}

pub(crate) fn napi_err(error: windows::core::Error) -> Error {
    Error::from_reason(error.to_string())
}
