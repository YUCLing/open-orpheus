use std::{
    mem::ManuallyDrop,
    sync::{Mutex, OnceLock, mpsc},
    time::Duration,
};

use napi::{
    Env, Error, Result, Unknown, ValueType,
    bindgen_prelude::{Array, Buffer, FnArgs, FromNapiValue, Function, Object},
    threadsafe_function::{ThreadsafeCallContext, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;

mod proxy;
mod wayland;
mod x11;

static DISABLE_DISPLAY_SERVER_HOOKS: OnceLock<bool> = OnceLock::new();

// Watchers run on the Wayland thread. Retain their N-API handles until a
// main-thread API call can release them, including the final cancellation.
type RetiredRelease = Box<dyn FnOnce() + Send>;
static RETIRED_RELEASES: OnceLock<Mutex<Vec<RetiredRelease>>> = OnceLock::new();

struct ThreadsafeRelease<T: Send + 'static>(Option<ManuallyDrop<T>>);

impl<T: Send + 'static> Drop for ThreadsafeRelease<T> {
    fn drop(&mut self) {
        if let Some(value) = self.0.take() {
            retire_release(move || drop(ManuallyDrop::into_inner(value)));
        }
    }
}

fn retire_release(release: impl FnOnce() + Send + 'static) {
    RETIRED_RELEASES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .push(Box::new(release));
}

pub fn reap_retired_releases() {
    let pending = std::mem::take(
        &mut *RETIRED_RELEASES
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
    );
    for release in pending {
        release();
    }
}

fn disable_display_server_hooks() -> bool {
    *DISABLE_DISPLAY_SERVER_HOOKS.get_or_init(|| {
        std::env::var("DISABLE_DISPLAY_SERVER_HOOKS")
            .ok()
            .map(|v| {
                let value = v.trim().to_ascii_lowercase();
                !value.is_empty() && value != "0" && value != "false" && value != "no"
            })
            .unwrap_or(false)
    })
}

pub fn supports_native_wayland_popup() -> bool {
    !disable_display_server_hooks() && wayland::is_wayland()
}

pub fn popup_capability() -> (bool, Option<String>) {
    if disable_display_server_hooks() {
        return (false, Some("hooks-disabled".to_string()));
    }
    if !wayland::is_wayland() {
        return (false, Some("not-wayland".to_string()));
    }
    (true, None)
}

#[derive(Clone, Copy)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

pub fn is_wayland() -> bool {
    wayland::is_wayland()
}

pub fn is_x11() -> bool {
    x11::is_x11()
}

/// Whether the compositor advertises `zwlr_layer_shell_v1`.
pub fn is_layer_shell_available() -> bool {
    wayland::is_layer_shell_available()
}

/// The compositor's name for the output Electron reports as a `Display.id`.
pub fn output_name(display_id: u32) -> Option<String> {
    if disable_display_server_hooks() {
        return None;
    }

    wayland::output_name(display_id)
}

/// Register the layer-shell policy for a managed window.
///
/// Keyed by the id the application names the window with, so it can be set
/// before the window — or its surface — exists. Invalid options are refused
/// here because a protocol error would close the display connection.
pub fn set_layer_policy(window_id: &str, options: &crate::LayerShellOptions) -> bool {
    if disable_display_server_hooks() {
        return false;
    }

    wayland::set_layer_policy(window_id, to_wayland_options(options))
}

/// Withdraw the layer-shell policy for a managed window.
///
/// A surface that already took the layer role keeps it for its life; only the
/// window's next surface is affected.
pub fn clear_layer_policy(window_id: &str) -> bool {
    wayland::clear_layer_policy(window_id)
}

/// Re-key the native state recorded for one managed window under another.
///
/// A policy switch replaces the wrapper with a different window id; the
/// layer-shell policy and the recorded input region follow it.
pub fn transfer_window_state(from_id: &str, to_id: &str) -> bool {
    wayland::transfer_window_state(from_id, to_id)
}

/// Release the native state recorded for a window that will not return.
pub fn forget_window_state(window_id: &str) -> bool {
    wayland::forget_window_state(window_id)
}

/// Decorate a title with the managed window id the proxy keys windows on.
pub fn decorate_title(id: &str, title: &str) -> String {
    wayland::decorate_title(id, title)
}

/// Whether these options could be handed to the compositor at all.
pub fn validate_layer_window(options: &crate::LayerShellOptions) -> bool {
    if disable_display_server_hooks() {
        return false;
    }

    wayland::validate_layer_window(to_wayland_options(options))
}

/// Translate the public options into the ones the protocol layer speaks.
fn to_wayland_options(options: &crate::LayerShellOptions) -> wayland::LayerShellOptions {
    let mut anchor = 0;
    if options.anchor_top.unwrap_or(false) {
        anchor |= wayland::ANCHOR_TOP;
    }
    if options.anchor_bottom.unwrap_or(false) {
        anchor |= wayland::ANCHOR_BOTTOM;
    }
    if options.anchor_left.unwrap_or(false) {
        anchor |= wayland::ANCHOR_LEFT;
    }
    if options.anchor_right.unwrap_or(false) {
        anchor |= wayland::ANCHOR_RIGHT;
    }

    wayland::LayerShellOptions {
        namespace: options.namespace.clone(),
        layer: match options.layer {
            Some(crate::LayerShellLayer::Background) => wayland::LAYER_BACKGROUND,
            Some(crate::LayerShellLayer::Bottom) => wayland::LAYER_BOTTOM,
            Some(crate::LayerShellLayer::Top) => wayland::LAYER_TOP,
            Some(crate::LayerShellLayer::Overlay) => wayland::LAYER_OVERLAY,
            None => wayland::LAYER_TOP,
        },
        output: options.output,
        anchor,
        width: options.width.unwrap_or(0),
        height: options.height.unwrap_or(0),
        margin_top: options.margin_top.unwrap_or(0),
        margin_right: options.margin_right.unwrap_or(0),
        margin_bottom: options.margin_bottom.unwrap_or(0),
        margin_left: options.margin_left.unwrap_or(0),
        exclusive_zone: options.exclusive_zone.unwrap_or(0),
        keyboard_interactivity: options
            .keyboard_interactivity
            .unwrap_or(wayland::KEYBOARD_NONE),
    }
}

#[napi]
pub fn drag_window(env: Env, hwnd: Buffer) -> Result<()> {
    if wayland::is_wayland() {
        wayland::send_xdg_toplevel_move();
        return Ok(());
    }

    if hwnd.len() < 4 {
        return env.throw("Invalid buffer size for window handle");
    }
    let Some(window) = hwnd
        .get(0..4)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()) as u64)
    else {
        return env.throw("Failed to parse window handle");
    };

    if !x11::send_net_wm_moveresize_move(window as u32) {
        return env.throw("Failed to send _NET_WM_MOVERESIZE_MOVE event");
    }

    Ok(())
}

#[napi]
pub fn set_window_as_background(env: Env, hwnd: Buffer, display_id: Option<u32>) -> Result<()> {
    // The window stays top-level here; placement is `setBounds`' job.
    let _ = display_id;

    if !x11::is_x11() {
        return env.throw("This API is supported only in X11.");
    }

    if hwnd.len() < 4 {
        return env.throw("Invalid buffer size for window handle");
    }
    let Some(window) = hwnd
        .get(0..4)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
    else {
        return env.throw("Failed to parse window handle");
    };

    if !x11::set_window_as_background(window) {
        return env.throw("Failed to set as background window");
    }

    Ok(())
}

/// The compositor's unique name for the output Electron reports as a `Display.id`.
///
/// On Linux, this is the `wl_output.name` event (for example `DP-1`), looked up
/// across the live Wayland connections. `null` when none of them knows the display,
/// the client has not bound it yet, or the compositor is too old to send a name.
///
/// On the other platforms, this is a ID that will be consistent across sessions.
#[napi]
pub fn get_unique_display_id(display_id: u32) -> Option<String> {
    crate::linux::output_name(display_id)
}

pub fn set_input_region(window_handle: Unknown, rects: Option<Array>) -> Result<bool> {
    let mut parsed_rects = None;
    if let Some(arr) = rects {
        let mut r = Vec::with_capacity(arr.len() as usize);
        for i in 0..arr.len() {
            let obj: Object = arr.get(i)?.unwrap();
            let x = obj
                .get("x")?
                .ok_or_else(|| Error::from_reason("Incorrect rect"))?;
            let y = obj
                .get("y")?
                .ok_or_else(|| Error::from_reason("Incorrect rect"))?;
            let w = obj
                .get("w")?
                .ok_or_else(|| Error::from_reason("Incorrect rect"))?;
            let h = obj
                .get("h")?
                .ok_or_else(|| Error::from_reason("Incorrect rect"))?;
            r.push(Rect { x, y, w, h });
        }
        parsed_rects = Some(r);
    }

    if wayland::is_wayland() {
        if window_handle.get_type()? == ValueType::String {
            let s: String = unsafe { window_handle.cast() }?;
            return Ok(wayland::set_input_region_rects(&s, parsed_rects.as_deref()));
        }
    } else if x11::is_x11()
        && let Ok(buf) = Buffer::from_unknown(window_handle)
        && buf.len() >= 4
    {
        // Modified to permit 8-byte Electron buffers directly natively
        let window = u32::from_le_bytes(buf[0..4].try_into().unwrap());
        return Ok(x11::set_input_region_rects(window, parsed_rects.as_deref()));
    }

    Ok(false)
}

/// Fetch the current cursor position via an injected X11 QueryPointer request.
///
/// Returns `Some((x, y))` in root-window coordinates on success, or `None` if
/// X11 is not active or the query timed out.
pub fn get_cursor_position() -> Option<(i32, i32)> {
    if !x11::is_x11() {
        return None;
    }
    x11::query_pointer(0).map(|(x, y)| (x as i32, y as i32))
}

pub fn on_layer_shell_role_refused(env: Env, callback: Function<String, ()>) -> Result<()> {
    if disable_display_server_hooks() {
        return env.throw("onLayerShellRoleRefused is unavailable when Wayland hooks are disabled");
    }

    let callback = callback
        .build_threadsafe_function()
        .build_callback(|ctx: ThreadsafeCallContext<String>| Ok(ctx.value))?;

    if !wayland::on_layer_shell_refused(Box::new(move |window_id: String| {
        callback.call(window_id, ThreadsafeFunctionCallMode::NonBlocking);
    })) {
        return env.throw(
            "onLayerShellRoleRefused is unavailable because Wayland hooks are not initialized",
        );
    }

    Ok(())
}

/// Capture the first pointer enter on a window that already has a surface.
pub fn capture_cursor_enter(window_id: String, timeout_ms: u32) -> Option<(i32, i32)> {
    if disable_display_server_hooks() || !wayland::is_wayland() {
        return None;
    }

    let (sender, receiver) = mpsc::sync_channel(1);
    let token = wayland::on_window_cursor_enter(
        &window_id,
        Box::new(move |position| {
            let _ = sender.send(position);
        }),
    )?;

    match receiver.recv_timeout(Duration::from_millis(u64::from(timeout_ms))) {
        Ok(Some((x, y))) if x >= 0 && y >= 0 => Some((x, y)),
        Ok(_) => None,
        Err(_) => {
            wayland::cancel_window_cursor_enter(token);
            None
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn set_popup_policy(
    target_window_id: String,
    parent_window_id: String,
    width: i32,
    height: i32,
    anchor_x: Option<i32>,
    anchor_y: Option<i32>,
    shadow_inset: Option<i32>,
    anchor_rect_width: Option<i32>,
) -> bool {
    if !supports_native_wayland_popup() {
        return false;
    }
    let anchor = anchor_x.zip(anchor_y);
    wayland::set_popup_policy(
        &target_window_id,
        &parent_window_id,
        width,
        height,
        anchor,
        shadow_inset.unwrap_or(0),
        anchor_rect_width,
    )
}

pub fn clear_popup_policy(target_window_id: String) -> bool {
    wayland::clear_popup_policy(&target_window_id)
}

pub fn is_window_activated(window_id: String) -> bool {
    wayland::window_is_activated(&window_id)
}

pub fn is_window_wayland_popup(window_id: String) -> bool {
    wayland::window_is_popup(&window_id)
}

pub fn latest_window_press() -> Option<(String, i32, i32, bool, u32)> {
    wayland::latest_press()
}

pub fn window_pointer_position(window_id: String) -> Option<(i32, i32)> {
    wayland::window_pointer_position(&window_id)
}

pub fn capture_window_touch(
    window_id: String,
    callback: Function<FnArgs<(i32, i32)>, ()>,
) -> Result<u32> {
    reap_retired_releases();
    let mut callback = ThreadsafeRelease(Some(ManuallyDrop::new(
        callback
            .build_threadsafe_function()
            .build_callback(|ctx: ThreadsafeCallContext<(i32, i32)>| Ok(ctx.value))?,
    )));
    let token = wayland::on_window_touch(&window_id, move |x, y| {
        let Some(cb) = callback.0.take() else {
            return;
        };
        cb.call((x, y), ThreadsafeFunctionCallMode::NonBlocking);
        retire_release(move || drop(ManuallyDrop::into_inner(cb)));
    });
    token.ok_or_else(|| Error::from_reason("captureWindowTouch could not find the window"))
}

pub fn cancel_window_touch(token: u32) -> bool {
    let cancelled = wayland::cancel_window_touch(token);
    reap_retired_releases();
    cancelled
}

pub fn window_last_press_age_ms(window_id: String) -> Option<u32> {
    wayland::window_last_press_age_ms(&window_id)
}

pub fn window_pointer_inside(window_id: String) -> bool {
    wayland::window_pointer_inside(&window_id)
}

pub fn capture_window_next_pointer_axis(
    window_id: String,
    callback: Function<FnArgs<(u32,)>, ()>,
) -> Result<u32> {
    reap_retired_releases();
    if disable_display_server_hooks() || !wayland::is_wayland() {
        return Err(Error::from_reason(
            "captureWindowNextPointerAxis requires active Wayland hooks",
        ));
    }
    let mut callback = Some(ManuallyDrop::new(
        callback.build_threadsafe_function().build_callback(
            |ctx: ThreadsafeCallContext<u32>| {
                Ok(std::convert::Into::<FnArgs<(u32,)>>::into((ctx.value,)))
            },
        )?,
    ));
    let token = wayland::on_next_pointer_axis(&window_id, move |axis| {
        let Some(cb) = callback.take() else {
            return;
        };
        if let Some(axis) = axis {
            cb.call(axis, ThreadsafeFunctionCallMode::NonBlocking);
        }
        retire_release(move || drop(ManuallyDrop::into_inner(cb)));
    });
    token.ok_or_else(|| Error::from_reason("Unable to watch pointer axis for this Wayland window"))
}

pub fn cancel_window_pointer_axis_capture(token: u32) -> bool {
    reap_retired_releases();
    let cancelled = wayland::cancel_pointer_axis_watcher(token);
    reap_retired_releases();
    cancelled
}

#[napi_derive::module_init]
fn main() {
    if !disable_display_server_hooks() {
        proxy::init_hooks();
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn on_unload() {
    if !disable_display_server_hooks() {
        proxy::remove_hooks();
    }
}

#[used]
#[unsafe(link_section = ".fini_array")]
static DESTRUCTOR: extern "C" fn() = on_unload;

#[cfg(test)]
mod tests {
    use super::{reap_retired_releases, retire_release};

    #[test]
    fn watcher_release_is_deferred_to_the_reaping_thread() {
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            retire_release(move || {
                sender.send(std::thread::current().id()).unwrap();
            });
        })
        .join()
        .unwrap();
        assert!(receiver.try_recv().is_err());
        reap_retired_releases();
        assert_eq!(receiver.recv().unwrap(), std::thread::current().id());
        reap_retired_releases();
        assert!(receiver.try_recv().is_err());
    }
}
