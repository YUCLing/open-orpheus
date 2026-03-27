use std::sync::Arc;

use neon::{
    handle::Handle,
    object::Object,
    prelude::{Context, Cx},
    types::{JsBuffer, JsFunction, JsPromise, buffer::TypedArray, extract::Json},
};

use crate::{
    app::App,
    osr::{OsrInputEvent, OsrWindow, OsrWindowOptions},
};

/// Creates a native OSR window and returns a `Promise<number>` that resolves
/// with the opaque window pointer.
#[neon::export]
fn create_osr_window<'cx>(
    cx: &mut Cx<'cx>,
    app_ptr: f64,
    Json(options): Json<OsrWindowOptions>,
) -> Handle<'cx, JsPromise> {
    let (deferred, promise) = cx.promise();
    let channel = cx.channel();

    smol::spawn(async move {
        let app = unsafe { &*(app_ptr as usize as *const App) };
        let window = OsrWindow::new(app, options).await;
        let ptr = Box::into_raw(Box::new(window)) as usize;
        channel.send(move |mut cx| {
            let val = cx.number(ptr as f64);
            deferred.resolve(&mut cx, val);
            Ok(())
        });
    })
    .detach();

    promise
}

/// Sends a BGRA bitmap frame to the native window.  The buffer is consumed
/// and converted to RGBA internally.
#[neon::export]
fn osr_window_update_frame<'cx>(
    cx: &mut Cx<'cx>,
    window_ptr: f64,
    buffer: Handle<'cx, JsBuffer>,
    width: f64,
    height: f64,
) {
    let window = unsafe { &*(window_ptr as usize as *const OsrWindow) };
    let mut pixels = TypedArray::as_slice(&*buffer, cx).to_vec();
    window.update_frame(&mut pixels, width as usize, height as usize);
}

/// Registers a JS callback that receives serialised [`OsrInputEvent`] objects
/// whenever the native window receives input or lifecycle events.
#[neon::export]
fn osr_window_set_input_handler<'cx>(
    cx: &mut Cx<'cx>,
    window_ptr: f64,
    callback: Handle<'cx, JsFunction>,
) {
    let window = unsafe { &*(window_ptr as usize as *const OsrWindow) };
    let callback = Arc::new(callback.root(cx));
    let channel = cx.channel();

    window.set_input_handler(move |event: OsrInputEvent| {
        let json = match serde_json::to_string(&event) {
            Ok(s) => s,
            Err(_) => return,
        };
        let cb = callback.clone();
        let ch = channel.clone();
        ch.send(move |mut cx| {
            let func = cb.to_inner(&mut cx);
            let arg = cx.string(&json);
            func.call_with(&cx).arg(arg).exec(&mut cx)?;
            Ok(())
        });
    });
}

/// Resizes the native window to the given logical dimensions.
#[neon::export]
fn osr_window_resize(window_ptr: f64, width: f64, height: f64) {
    let window = unsafe { &*(window_ptr as usize as *const OsrWindow) };
    window.resize(width, height);
}

/// Sets the cursor icon on the native window from a CSS cursor name.
#[neon::export]
fn osr_window_set_cursor(window_ptr: f64, cursor_name: String) {
    let window = unsafe { &*(window_ptr as usize as *const OsrWindow) };
    window.set_cursor(&cursor_name);
}

/// Begins an interactive drag of the native window.
#[neon::export]
fn osr_window_drag(window_ptr: f64) {
    let window = unsafe { &*(window_ptr as usize as *const OsrWindow) };
    window.drag();
}

/// Closes the native window.
#[neon::export]
fn osr_window_close(window_ptr: f64) {
    let window = unsafe { &*(window_ptr as usize as *const OsrWindow) };
    window.close();
}

/// Destroys the `OsrWindow`, releasing all associated resources.
#[neon::export]
fn destroy_osr_window(window_ptr: f64) {
    let window = unsafe { Box::from_raw(window_ptr as usize as *mut OsrWindow) };
    window.close();
    // Box is dropped here, freeing the OsrWindow.
}
