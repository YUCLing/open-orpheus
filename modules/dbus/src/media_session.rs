use std::sync::Arc;

use napi::{bindgen_prelude::Object, threadsafe_function::ThreadsafeFunction, Env, Error, Result};
use napi_derive::napi;
use smol::lock::Mutex;
use zbus::Connection;

use crate::media_session::mpris::{
    Interface, MprisMetadata, PlaybackState, PlayerInterface, PlayerInterfaceSignals,
};

mod mpris;

const MPRIS_OBJECT_PATH: &str = "/org/mpris/MediaPlayer2";

#[napi]
#[derive(PartialEq, Clone, Copy)]
pub enum PlaybackStatus {
    Playing,
    Paused,
    Stopped,
}

struct Playlist {}

#[napi]
pub enum MediaSessionEvents {
    Raise,
    Quit,
    Play,
    Pause,
    Next,
    Previous,
    Seek { delta: i64 },
    SetPosition { position: i64 },
    SetVolume { volume: f64 },
}

#[napi]
pub struct MediaSession {
    conn: Connection,
    event_handler: Arc<Mutex<Option<ThreadsafeFunction<MediaSessionEvents, ()>>>>,
}

macro_rules! napi_deferred_task {
    ($env:ident, $body:expr) => {{
        let (deferred, object) = $env.create_deferred()?;
        smol::spawn(async move {
            match $body.await {
                Ok(val) => deferred.resolve(move |_env| Ok(val)),
                Err(err) => deferred.reject(Error::from_reason(err.to_string())),
            }
        })
        .detach();
        Ok(object)
    }};
}

#[napi]
impl MediaSession {
    #[napi(constructor)]
    pub fn new(name: String, identity: String, desktop_entry: String) -> Result<Self> {
        let (event_tx, event_rx) = smol::channel::unbounded::<MediaSessionEvents>();
        let interface = Interface {
            tx: event_tx.clone(),
            identity,
            desktop_entry,
        };
        let player_interface = PlayerInterface {
            tx: event_tx.clone(),
            volume: 1.0,
            playback_state: None,
            metadata: None,
        };
        let conn = smol::block_on::<zbus::Result<Connection>>(async {
            let conn = Connection::session().await?;
            let srv = conn.object_server();
            srv.at(MPRIS_OBJECT_PATH, interface).await?;
            srv.at(MPRIS_OBJECT_PATH, player_interface).await?;

            conn.request_name(format!("org.mpris.MediaPlayer2.{}", name))
                .await?;
            Ok(conn)
        })
        .map_err(|x| Error::from_reason(x.description().unwrap_or_default()))?;

        let event_handler: Arc<Mutex<Option<ThreadsafeFunction<MediaSessionEvents, ()>>>> =
            Arc::new(Mutex::new(None));
        let cloned_event_handler = event_handler.clone();
        smol::spawn(async move {
            while let Ok(event) = event_rx.recv().await {
                let Some(event_handler) = &*cloned_event_handler.lock().await else {
                    continue;
                };
                let _ = event_handler.call_async(Ok(event)).await;
            }
        })
        .detach();

        Ok(Self {
            conn,
            event_handler,
        })
    }

    #[napi]
    pub fn set_event_handler(&self, handler: Option<ThreadsafeFunction<MediaSessionEvents, ()>>) {
        *self.event_handler.lock_blocking() = handler;
    }

    #[napi]
    pub fn set_metadata<'a>(
        &'a self,
        env: &'a Env,
        metadata: Option<MprisMetadata>,
    ) -> Result<Object<'a>> {
        let conn = self.conn.clone();
        napi_deferred_task!(env, async {
            let iface_ref = conn
                .object_server()
                .interface::<_, PlayerInterface>(MPRIS_OBJECT_PATH)
                .await
                .map_err(|e| e.to_string())?;
            let mut iface = iface_ref.get_mut().await;
            iface.metadata = metadata;
            iface
                .metadata_changed(iface_ref.signal_emitter())
                .await
                .map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        })
    }

    #[napi]
    pub fn set_volume<'a>(&'a self, env: &'a Env, volume: f64) -> Result<Object<'a>> {
        let conn = self.conn.clone();
        napi_deferred_task!(env, async {
            let iface_ref = conn
                .object_server()
                .interface::<_, PlayerInterface>(MPRIS_OBJECT_PATH)
                .await
                .map_err(|e| e.to_string())?;
            let mut iface = iface_ref.get_mut().await;
            iface.volume = volume;
            iface
                .volume_changed(iface_ref.signal_emitter())
                .await
                .map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        })
    }

    #[napi]
    pub fn update_playback_state<'a>(
        &'a self,
        env: &'a Env,
        playback_state: Option<PlaybackState>,
    ) -> Result<Object<'a>> {
        let conn = self.conn.clone();
        napi_deferred_task!(env, async {
            let iface_ref = conn
                .object_server()
                .interface::<_, PlayerInterface>(MPRIS_OBJECT_PATH)
                .await
                .map_err(|e| e.to_string())?;
            let mut iface = iface_ref.get_mut().await;

            let state_was_available = iface.playback_state.is_some();
            let state_is_available = playback_state.is_some();

            let prev_status = iface.playback_state.as_ref().map(|x| x.status);
            let new_status = playback_state.as_ref().map(|x| x.status);

            let prev_speed = iface.playback_state.as_ref().and_then(|x| x.speed);
            let new_speed = playback_state.as_ref().and_then(|x| x.speed);

            iface.playback_state = playback_state;

            if state_was_available != state_is_available {
                iface
                    .can_play_changed(iface_ref.signal_emitter())
                    .await
                    .map_err(|e| e.to_string())?;
                iface
                    .can_pause_changed(iface_ref.signal_emitter())
                    .await
                    .map_err(|e| e.to_string())?;
                iface
                    .can_seek_changed(iface_ref.signal_emitter())
                    .await
                    .map_err(|e| e.to_string())?;
            }

            if prev_status != new_status {
                iface
                    .playback_status_changed(iface_ref.signal_emitter())
                    .await
                    .map_err(|e| e.to_string())?;
            }

            if prev_speed != new_speed {
                iface
                    .rate_changed(iface_ref.signal_emitter())
                    .await
                    .map_err(|e| e.to_string())?;
            }

            Ok::<(), String>(())
        })
    }

    #[napi]
    pub fn send_seeked<'a>(&'a self, env: &'a Env, time: i64) -> Result<Object<'a>> {
        let conn = self.conn.clone();
        napi_deferred_task!(env, async {
            conn.object_server()
                .interface::<_, PlayerInterface>(MPRIS_OBJECT_PATH)
                .await
                .map_err(|e| e.to_string())?
                .seeked(time)
                .await
                .map_err(|e| e.to_string())?;

            Ok::<(), String>(())
        })
    }
}
