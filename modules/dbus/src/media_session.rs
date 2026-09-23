use std::sync::{Arc, Mutex as StdMutex, MutexGuard};

use napi::bindgen_prelude::{Either, Object, Promise, Undefined};
use napi::threadsafe_function::ThreadsafeFunction;
use napi::{Env, Error, Result};
use napi_derive::napi;
use zbus::Connection;

use crate::media_session::mpris::{
    Interface, MprisMetadata, PlaybackState, PlayerInterface, PlayerState,
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

#[allow(dead_code)]
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

/// What a JS event handler may return.
///
/// A handler may be synchronous (it returns nothing) or asynchronous (it
/// returns a promise). The promise arm must come *first*: `Either` picks the
/// first arm whose value validates, and the `Undefined` arm accepts anything.
type EventReturn = Either<Promise<()>, Undefined>;

type EventHandler = Arc<ThreadsafeFunction<MediaSessionEvents, EventReturn>>;

/// Lock a `std::sync::Mutex`, recovering the guard if a previous holder
/// panicked. These locks are always released before awaiting, so poisoning is
/// not a meaningful signal.
fn lock<T>(mutex: &StdMutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Shared handle to the JS event handler.
///
/// The zbus interfaces and the JS-facing `MediaSession` each hold a clone, so
/// `set_event_handler` can swap the handler at any time while commands already
/// in flight keep the handler they started with alive.
#[derive(Clone, Default)]
pub struct EventDispatcher {
    handler: Arc<StdMutex<Option<EventHandler>>>,
}

impl EventDispatcher {
    pub fn set(&self, handler: Option<EventHandler>) {
        *lock(&self.handler) = handler;
    }

    /// Hand `event` to JS and wait for the handler to finish.
    ///
    /// The handler is cloned out of the slot and the slot lock is released
    /// before calling into JS: the callback runs on the thread that also calls
    /// `set_event_handler`, so holding the lock across the call would deadlock
    /// that thread — and with it the very callback the lock is waiting on.
    ///
    /// A missing handler is an error rather than a silently dropped event, and
    /// a rejected handler promise (or a throw) is reported back to the D-Bus
    /// caller.
    pub async fn dispatch(&self, event: MediaSessionEvents) -> std::result::Result<(), String> {
        let handler = lock(&self.handler).clone();
        let Some(handler) = handler else {
            return Err("No media session event handler is registered".to_string());
        };

        match handler.call_async(Ok(event)).await {
            Ok(Either::A(promise)) => promise.await.map_err(|e| e.to_string()),
            Ok(Either::B(())) => Ok(()),
            Err(err) => Err(err.to_string()),
        }
    }
}

#[napi]
pub struct MediaSession {
    conn: Connection,
    state: Arc<StdMutex<PlayerState>>,
    dispatcher: EventDispatcher,
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
        let state = Arc::new(StdMutex::new(PlayerState::new()));
        let dispatcher = EventDispatcher::default();

        let interface = Interface {
            dispatcher: dispatcher.clone(),
            identity,
            desktop_entry,
        };
        let player_interface = PlayerInterface {
            dispatcher: dispatcher.clone(),
            state: state.clone(),
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

        Ok(Self {
            conn,
            state,
            dispatcher,
        })
    }

    #[napi]
    pub fn set_event_handler(
        &self,
        handler: Option<ThreadsafeFunction<MediaSessionEvents, Either<Promise<()>, Undefined>>>,
    ) {
        self.dispatcher.set(handler.map(Arc::new));
    }

    #[napi]
    pub fn set_metadata<'a>(
        &'a self,
        env: &'a Env,
        metadata: Option<MprisMetadata>,
    ) -> Result<Object<'a>> {
        let conn = self.conn.clone();
        let state = self.state.clone();
        napi_deferred_task!(env, async {
            mpris::update_metadata(&conn, &state, metadata).await
        })
    }

    #[napi]
    pub fn set_volume<'a>(&'a self, env: &'a Env, volume: f64) -> Result<Object<'a>> {
        let conn = self.conn.clone();
        let state = self.state.clone();
        napi_deferred_task!(env, async {
            mpris::update_volume(&conn, &state, volume).await
        })
    }

    #[napi]
    pub fn update_playback_state<'a>(
        &'a self,
        env: &'a Env,
        playback_state: Option<PlaybackState>,
    ) -> Result<Object<'a>> {
        let conn = self.conn.clone();
        let state = self.state.clone();
        napi_deferred_task!(env, async {
            mpris::update_playback_state(&conn, &state, playback_state).await
        })
    }

    #[napi]
    pub fn send_seeked<'a>(&'a self, env: &'a Env, time: i64) -> Result<Object<'a>> {
        let conn = self.conn.clone();
        napi_deferred_task!(env, async { mpris::send_seeked(&conn, time).await })
    }
}
