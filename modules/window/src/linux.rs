use std::{mem::ManuallyDrop, sync::OnceLock};

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

/// Queue a layer-shell declaration for the next toplevel the client creates.
///
/// The window is identified by position rather than by name: whoever creates
/// the next toplevel on any Wayland connection gets the declaration. Invalid
/// options are refused here, because a protocol error would take the whole
/// display connection down.
pub fn declare_layer_window(options: &crate::LayerShellOptions) -> bool {
    if disable_display_server_hooks() {
        return false;
    }

    wayland::declare_layer_window(to_wayland_options(options))
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

/// Withdraw the newest layer-shell declaration that is still pending.
pub fn cancel_layer_window() -> bool {
    wayland::cancel_layer_window()
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

pub fn capture_next_window_first_cursor_enter(
    env: Env,
    callback: Function<FnArgs<(i32, i32)>, ()>,
) -> Result<()> {
    if disable_display_server_hooks() {
        return env.throw(
            "captureNextWindowFirstCursorEnter is unavailable when Wayland hooks are disabled",
        );
    }

    // Give only one undroppable reference to the callback closure below, to avoid double drop
    // when FD close (FD close causes the closure to drop its referenced value)
    let mut callback = Some(ManuallyDrop::new(
        callback.build_threadsafe_function().build_callback(
            |ctx: ThreadsafeCallContext<(u32, u32)>| {
                Ok(std::convert::Into::<FnArgs<(u32, u32)>>::into(ctx.value))
            },
        )?,
    ));

    if !wayland::on_next_new_window_first_cursor_enter(move |x, y| {
        if x < 0 || y < 0 {
            return;
        }
        let Some(cb) = callback.take() else {
            return;
        };
        cb.call(
            (x as u32, y as u32),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
        // Now we can safely drop it only once
        ManuallyDrop::into_inner(cb);
    }) {
        return env.throw("captureNextWindowFirstCursorEnter is unavailable because Wayland hooks are not initialized");
    }

    Ok(())
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
