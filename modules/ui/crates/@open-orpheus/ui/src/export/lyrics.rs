use std::sync::{Arc, Mutex};

use egui::{ViewportBuilder, ViewportId};
use neon::{
    handle::Handle,
    object::Object,
    prelude::{Context, Cx},
    types::{JsPromise, extract::Json},
};

use crate::{
    app::App,
    components::lyrics::{LyricsData, LyricsState, LyricsStyleDto, LyricsWidget},
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
fn create_lyrics_window<'cx>(cx: &mut Cx<'cx>, app_ptr: f64, show: bool) -> Handle<'cx, JsPromise> {
    let (deferred, promise) = cx.promise();
    let channel = cx.channel();

    smol::spawn(async move {
        let app = unsafe { &*(app_ptr as usize as *mut App) };

        let state = Arc::new(Mutex::new(LyricsState::new()));
        let state_for_ui = state.clone();

        let (_ctx, window_id) = app
            .create_egui_window(
                ViewportId::from_hash_of("lyrics_test"),
                ViewportBuilder::default()
                    .with_title("Lyrics Test")
                    .with_inner_size([600.0, 200.0])
                    .with_transparent(true)
                    .with_decorations(true)
                    .with_visible(show),
                move |ctx| {
                    let frame = egui::Frame::new().fill(egui::Color32::from_black_alpha(180));

                    egui::CentralPanel::default().frame(frame).show(ctx, |ui| {
                        let mut state = state_for_ui.lock().unwrap();
                        ui.add(LyricsWidget::new(&mut state));
                        if state.playing {
                            ctx.request_repaint();
                        }
                    });
                },
            )
            .await;

        let handle = Box::new(LyricsWindow { state });
        let ptr = Box::into_raw(handle) as usize as f64;

        let wid = u64::from(window_id) as f64;
        channel.send(move |mut cx| {
            let arr = cx.empty_array();
            let v0 = cx.number(ptr);
            let v1 = cx.number(wid);
            arr.set(&mut cx, 0, v0)?;
            arr.set(&mut cx, 1, v1)?;
            deferred.resolve(&mut cx, arr);
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

/// Merges a partial style update into the lyrics window's current style.
///
/// JS signature: `setLyricsStyle(ptr: number, style: Partial<LyricsStyleDto>): void`
#[neon::export]
fn set_lyrics_style(ptr: f64, style_dto: Json<LyricsStyleDto>) {
    let handle = unsafe { &*(ptr as usize as *const LyricsWindow) };
    let mut state = handle.state.lock().unwrap();
    style_dto.0.apply_to(&mut state.style);
}
