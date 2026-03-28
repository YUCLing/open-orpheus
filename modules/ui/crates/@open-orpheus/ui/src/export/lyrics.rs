use std::sync::{Arc, Mutex};

use egui::{ViewportBuilder, ViewportId};
use neon::{
    handle::Handle,
    prelude::{Context, Cx},
    types::{JsPromise, extract::Json},
};

use crate::{
    app::App,
    components::lyrics::{LyricsData, LyricsState, LyricsWidget},
};

/// Shared state between the JS caller (which pushes time & data) and the egui
/// render closure (which reads them each frame).
struct LyricsWindow {
    state: Arc<Mutex<LyricsState>>,
}

/// Creates a lyrics test window and returns a Promise that resolves with the
/// opaque pointer to the `LyricsWindow` handle.
///
/// JS signature: `createLyricsWindow(appPtr: number): Promise<number>`
#[neon::export]
fn create_lyrics_window<'cx>(cx: &mut Cx<'cx>, app_ptr: f64) -> Handle<'cx, JsPromise> {
    let (deferred, promise) = cx.promise();
    let channel = cx.channel();

    smol::spawn(async move {
        let app = unsafe { &*(app_ptr as usize as *mut App) };

        let state = Arc::new(Mutex::new(LyricsState::new()));
        let state_for_ui = state.clone();

        app.create_egui_window(
            ViewportId::from_hash_of("lyrics_test"),
            ViewportBuilder::default()
                .with_title("Lyrics Test")
                .with_inner_size([600.0, 200.0])
                .with_transparent(true)
                .with_decorations(true),
            move |ctx| {
                let frame = egui::Frame::new().fill(egui::Color32::from_black_alpha(180));

                egui::CentralPanel::default().frame(frame).show(ctx, |ui| {
                    let state = state_for_ui.lock().unwrap();
                    ui.add(LyricsWidget::new(&state));
                });

                ctx.request_repaint();
            },
        )
        .await;

        let handle = Box::new(LyricsWindow { state });
        let ptr = Box::into_raw(handle) as usize as f64;

        channel.send(move |mut cx| {
            let val = cx.number(ptr);
            deferred.resolve(&mut cx, val);
            Ok(())
        });
    })
    .detach();

    promise
}

/// Drops the `LyricsWindow` handle.
///
/// JS signature: `destroyLyricsWindow(ptr: number): void`
#[neon::export]
fn destroy_lyrics_window(ptr: f64) {
    let _ = unsafe { Box::from_raw(ptr as usize as *mut LyricsWindow) };
}

/// Sets the lyrics data for the test window. Pass `null` / `undefined` from JS
/// to clear.
///
/// JS signature: `setLyricsData(ptr: number, data: LyricsData | null): void`
#[neon::export]
fn set_lyrics_data(ptr: f64, data: Json<Option<LyricsData>>) {
    let handle = unsafe { &*(ptr as usize as *const LyricsWindow) };
    let mut state = handle.state.lock().unwrap();
    state.set_data(data.0);
}

/// Pushes the current playback time (in milliseconds) so the lyrics widget
/// can update its progress display.
///
/// JS signature: `setLyricsTime(ptr: number, timeMs: number): void`
#[neon::export]
fn set_lyrics_time(ptr: f64, time_ms: f64) {
    let handle = unsafe { &*(ptr as usize as *const LyricsWindow) };
    let mut state = handle.state.lock().unwrap();
    state.set_time(time_ms);
}
