#![deny(clippy::all)]

use napi::{
    Env, Result, Unknown,
    bindgen_prelude::{Array, FnArgs, Function},
};
use napi_derive::napi;

#[cfg(windows)]
pub mod windows;

#[cfg(target_os = "linux")]
pub mod linux;

#[cfg(target_os = "macos")]
pub mod macos;

#[napi]
pub enum DesktopEnvironment {
    Wayland,
    X11,
    Windows,
    Darwin,
    Unknown,
}

/// The stacking layer a layer surface is placed in, bottom-most first.
#[napi]
pub enum LayerShellLayer {
    Background,
    Bottom,
    Top,
    Overlay,
}

/// Layer-shell state for a window the application is about to create.
///
/// With an owner, applied only to that managed window; without one, applied to
/// the next eligible toplevel. Declare it before the window (or its surface) is
/// brought into existence. A declaration without size or anchors covers the output.
#[napi(object)]
pub struct LayerShellOptions {
    /// Purpose of the surface, e.g. `"open-orpheus-menu"`. Required.
    pub namespace: String,
    /// Defaults to the top layer.
    pub layer: Option<LayerShellLayer>,
    pub anchor_top: Option<bool>,
    pub anchor_bottom: Option<bool>,
    pub anchor_left: Option<bool>,
    pub anchor_right: Option<bool>,
    /// Surface size in surface-local coordinates. `0` lets the compositor
    /// decide, which requires the two opposite anchors on that axis.
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub margin_top: Option<i32>,
    pub margin_right: Option<i32>,
    pub margin_bottom: Option<i32>,
    pub margin_left: Option<i32>,
    /// `-1` ignore other surfaces, `0` avoid them, `>0` reserve space.
    pub exclusive_zone: Option<i32>,
    /// `0` none, `1` exclusive, `2` on demand (needs layer shell v4).
    pub keyboard_interactivity: Option<u32>,
}

/// Get current detected desktop environment.
///
/// Mostly for Linux to use, on Windows/macOS, returns hardcoded values.
#[napi]
pub fn get_desktop_environment() -> DesktopEnvironment {
    #[cfg(target_os = "macos")]
    return DesktopEnvironment::Darwin;

    #[cfg(windows)]
    return DesktopEnvironment::Windows;

    #[cfg(target_os = "linux")]
    {
        use crate::linux::{is_wayland, is_x11};
        if is_wayland() {
            DesktopEnvironment::Wayland
        } else if is_x11() {
            DesktopEnvironment::X11
        } else {
            DesktopEnvironment::Unknown
        }
    }
}

// region: Linux methods

/// Release completed native input callbacks on the JavaScript thread.
#[napi]
pub fn drain_window_callbacks() {
    #[cfg(target_os = "linux")]
    linux::reap_retired_releases();
}

/// Set regions that the window is used to receive inputs.
///
/// Only for Linux.
#[napi]
pub fn set_input_region(
    #[napi(ts_arg_type = "string | Buffer")] window_handle: Unknown,
    #[napi(ts_arg_type = "{ x: number, y: number, w: number, h: number }[] | null")] rects: Option<
        Array,
    >,
) -> Result<bool> {
    #[cfg(target_os = "linux")]
    {
        use crate::linux::set_input_region as set_input_region_impl;
        set_input_region_impl(window_handle, rects)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = window_handle;
        let _ = rects;
        Ok(false)
    }
}

/// Attach the managed window id to a title, the way the proxy expects it.
///
/// The window id rides in front of the real title, separated from it by
/// invisible characters, so the proxy can name the window on the wire while the
/// compositor is shown only the title. `ManagedWindow` writes titles through
/// this and nothing else writes them at all.
#[napi]
pub fn decorate_window_title(id: String, title: String) -> String {
    #[cfg(target_os = "linux")]
    {
        crate::linux::decorate_title(&id, &title)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = id;
        title
    }
}

/// Listen for windows whose layer-shell role was refused.
///
/// A compositor never releases a surface's role, so a window whose surface is
/// already an ordinary toplevel can never become a layer surface. The callback
/// gets the custom window id that was refused; the application has to re-create
/// that window (a new surface) for the role to apply.
///
/// Only for Wayland on Linux.
#[napi]
pub fn on_layer_shell_role_refused(
    env: Env,
    #[napi(ts_arg_type = "(windowId: string) => void")] callback: Function<String, ()>,
) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        use crate::linux::on_layer_shell_role_refused as on_layer_shell_role_refused_impl;
        on_layer_shell_role_refused_impl(env, callback)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = callback;
        env.throw("Only supports Linux")
    }
}

/// Listen for first CursorEnter event of the next created window.
///
/// Only for Wayland on Linux.
#[napi]
pub fn capture_next_window_first_cursor_enter(
    #[napi(ts_arg_type = "(x: number, y: number) => void")] callback: Function<
        FnArgs<(i32, i32)>,
        (),
    >,
) -> Result<u32> {
    #[cfg(target_os = "linux")]
    {
        use crate::linux::capture_next_window_first_cursor_enter as capture_next_window_first_cursor_enter_impl;
        capture_next_window_first_cursor_enter_impl(callback)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = callback;
        Err(napi::Error::from_reason("Only supports Linux"))
    }
}

/// Cancel a pending first-cursor-enter capture.
#[napi]
pub fn cancel_next_window_first_cursor_enter(token: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        linux::cancel_next_window_first_cursor_enter(token)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = token;
        false
    }
}

/// Reserve an xdg_popup role for `target_window_id` on its parent's connection.
///
/// Only that managed window may consume the reservation. Omit anchor coordinates
/// to use the last pointer-button position on the parent. `shadow_inset` excludes
/// transparent client-side shadow margins from the window geometry.
/// Returns no token when hooks or the required window/anchor/object-ID data
/// are unavailable; callers should retry briefly, then use their overlay path.
#[napi]
pub fn arm_next_window_as_popup(
    parent_window_id: String,
    target_window_id: String,
    width: i32,
    height: i32,
    anchor_x: Option<i32>,
    anchor_y: Option<i32>,
    shadow_inset: Option<i32>,
) -> Option<u32> {
    #[cfg(target_os = "linux")]
    {
        linux::arm_next_window_as_popup(
            parent_window_id,
            target_window_id,
            width,
            height,
            anchor_x,
            anchor_y,
            shadow_inset,
        )
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (
            parent_window_id,
            target_window_id,
            width,
            height,
            anchor_x,
            anchor_y,
            shadow_inset,
        );
        None
    }
}

/// Cancel a popup reservation that has not yet been consumed by its target window.
#[napi]
pub fn cancel_pending_popup(token: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        linux::cancel_pending_popup(token)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = token;
        false
    }
}

/// Whether this tracked BrowserWindow was actually converted to xdg_popup.
#[napi]
pub fn is_window_wayland_popup(window_id: String) -> bool {
    #[cfg(target_os = "linux")]
    {
        linux::is_window_wayland_popup(window_id)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = window_id;
        false
    }
}

/// Whether the active Wayland hooks allow a native popup attempt.
///
/// Independent of the desktop name. This does not guarantee that a particular
/// window can become a popup: arming still requires a tracked parent, anchor
/// data and a reusable object ID. Callers must retain an overlay fallback.
#[napi]
pub fn supports_native_wayland_popup() -> bool {
    #[cfg(target_os = "linux")]
    {
        linux::supports_native_wayland_popup()
    }

    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// Invoke once when a Wayland pointer-axis event reaches this window's client.
#[napi]
pub fn capture_window_next_pointer_axis(
    window_id: String,
    #[napi(ts_arg_type = "(axis: number) => void")] callback: Function<FnArgs<(u32,)>, ()>,
) -> Result<u32> {
    #[cfg(target_os = "linux")]
    {
        linux::capture_window_next_pointer_axis(window_id, callback)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (window_id, callback);
        Err(napi::Error::from_reason("Only supports Linux"))
    }
}

/// Cancel a pending pointer-axis capture.
#[napi]
pub fn cancel_window_pointer_axis_capture(token: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        linux::cancel_window_pointer_axis_capture(token)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = token;
        false
    }
}

/// Gets the position of the cursor
///
/// Only for X11 on Linux.
#[napi]
pub fn get_cursor_position() -> Result<Option<(f64, f64)>> {
    #[cfg(target_os = "linux")]
    {
        use crate::linux::get_cursor_position as get_cursor_position_impl;
        Ok(get_cursor_position_impl().map(|(x, y)| (x as f64, y as f64)))
    }

    #[cfg(not(target_os = "linux"))]
    {
        use napi::Error;

        Err(Error::from_reason("Only supports Linux"))
    }
}

/// Whether the compositor advertises `zwlr_layer_shell_v1`.
///
/// Only meaningful for Wayland on Linux; everywhere else it is `false`.
#[napi]
pub fn is_layer_shell_available() -> bool {
    #[cfg(target_os = "linux")]
    {
        crate::linux::is_layer_shell_available()
    }

    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// Make the next window a layer surface.
///
/// Must be called before the window — or, for an existing window, its surface —
/// is created: a compositor assigns a surface's role once and never changes it.
/// Returns whether the declaration was accepted; when it is refused the window
/// is still created as an ordinary one.
/// Named declarations belong only to that managed window; omit `owner` to use
/// the next eligible toplevel instead.
#[napi]
pub fn use_layer_shell_for_next_window(options: LayerShellOptions, owner: Option<String>) -> bool {
    #[cfg(target_os = "linux")]
    {
        crate::linux::declare_layer_window(&options, owner)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = options;
        let _ = owner;
        false
    }
}

/// Whether a layer-shell declaration could be sent.
///
/// The same option validation `useLayerShellForNextWindow` applies, without
/// queueing anything: callers can report a declaration that could never be
/// sent, and a settings UI can check a choice before anything is created.
///
/// This answers for the options only, never for the compositor: whether it
/// takes layer surfaces at all is `isLayerShellAvailable()`, and a caller that
/// needs both asks both.
#[napi]
pub fn validate_layer_shell_options(options: LayerShellOptions) -> bool {
    #[cfg(target_os = "linux")]
    {
        crate::linux::validate_layer_window(&options)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = options;
        false
    }
}

/// Withdraw the newest pending declaration for `owner`.
///
/// Omit `owner` to withdraw the newest unnamed declaration.
#[napi]
pub fn cancel_layer_shell_for_next_window(owner: Option<String>) -> bool {
    #[cfg(target_os = "linux")]
    {
        crate::linux::cancel_layer_window(owner.as_deref())
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = owner;
        false
    }
}

// endregion
