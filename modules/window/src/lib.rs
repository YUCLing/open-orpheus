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
    /// The output to create the surface on, by the name the compositor knows
    /// (for example `"DP-1"`) — the name `onLayerSurfaceOutput` reports. The
    /// compositor picks when this is absent or names an output it never
    /// advertised.
    ///
    /// A layer surface keeps the output it was created with for its whole life,
    /// so this is the only way to put a window on a particular one.
    pub output: Option<String>,
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

/// Register the intent to present `target_window_id` as an xdg_popup of
/// `parent_window_id`, with the size the renderer measured.
///
/// Identified by managed window id, like the layer-shell policy: the role is
/// decided when the decorated title names the window, and everything the
/// positioner needs (the parent's surface, the anchor, the object id) is
/// resolved then. Omit the anchor to use the last pointer-button position on
/// the parent. `shadow_inset` excludes transparent client-side shadow margins
/// from the window geometry. Returns whether the intent was accepted; callers
/// must still confirm the conversion and keep their overlay fallback.
#[napi]
pub fn set_window_popup_policy(
    target_window_id: String,
    parent_window_id: String,
    width: i32,
    height: i32,
    anchor_x: Option<i32>,
    anchor_y: Option<i32>,
    shadow_inset: Option<i32>,
) -> bool {
    #[cfg(target_os = "linux")]
    {
        linux::set_popup_policy(
            target_window_id,
            parent_window_id,
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
            target_window_id,
            parent_window_id,
            width,
            height,
            anchor_x,
            anchor_y,
            shadow_inset,
        );
        false
    }
}

/// Withdraw a popup policy the window will not use after all.
#[napi]
pub fn clear_window_popup_policy(target_window_id: String) -> bool {
    #[cfg(target_os = "linux")]
    {
        linux::clear_popup_policy(target_window_id)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = target_window_id;
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

/// How long ago the most recent pointer button press landed in this window.
///
/// `undefined` when that press was somewhere else, or there was none. A caller
/// can use it to tell a click that just happened here from a press that merely
/// happened at some point in the past.
#[napi]
pub fn window_last_press_age_ms(window_id: String) -> Option<u32> {
    #[cfg(target_os = "linux")]
    {
        linux::window_last_press_age_ms(window_id)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = window_id;
        None
    }
}

/// Whether a pointer is currently over this window's surface.
#[napi]
pub fn is_window_pointer_inside(window_id: String) -> bool {
    #[cfg(target_os = "linux")]
    {
        linux::window_pointer_inside(window_id)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = window_id;
        false
    }
}

/// Where a layer surface the user moved or resized ended up.
///
/// The coordinates are the ones the window's policy is written in, which is the
/// same logical space Electron reports.
#[napi(object)]
pub struct LayerSurfaceGeometry {
    /// The managed window id the surface belongs to.
    pub window_id: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Listen for a gesture the user pushed past the edge of the output it is on.
///
/// The window stopped at the edge because a layer surface keeps the output it
/// was created with, and there is no request to move it to another one; this is
/// the moment at which the application can decide to create the window again on
/// the output next to it. `edges` uses the xdg-toplevel resize edge flags: the
/// top, bottom, left and right of the window are 1, 2, 4 and 8.
///
/// Only for Wayland on Linux.
#[napi]
pub fn on_layer_surface_pushed(
    env: Env,
    #[napi(ts_arg_type = "(windowId: string, edges: number) => void")] callback: Function<
        FnArgs<(String, u32)>,
        (),
    >,
) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        use crate::linux::on_layer_surface_pushed as on_layer_surface_pushed_impl;
        on_layer_surface_pushed_impl(env, callback)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = callback;
        env.throw("Only supports Linux")
    }
}

/// Listen for a layer surface the user finished moving or resizing.
///
/// A compositor never tells a client where a layer surface is, and the native
/// layer is the one replaying the gesture, so this is the only way an
/// application learns where a surface ended up — and the only way it can put a
/// window it recreates back there.
///
/// Only for Wayland on Linux.
#[napi]
pub fn on_layer_surface_geometry(
    env: Env,
    #[napi(ts_arg_type = "(geometry: LayerSurfaceGeometry) => void")] callback: Function<
        LayerSurfaceGeometry,
        (),
    >,
) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        use crate::linux::on_layer_surface_geometry as on_layer_surface_geometry_impl;
        on_layer_surface_geometry_impl(env, callback)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = callback;
        env.throw("Only supports Linux")
    }
}

/// Listen for the output a converted window's layer surface ended up on.
///
/// A layer surface keeps the output the compositor created it on, and nothing
/// in the protocol ever says which that was — a client is only told that its
/// surface entered an output. That name is what a window created again after a
/// drag past the screen edge has to be asked for by, and it is the proxy's own
/// name for the output, so the application hands it straight back without
/// matching it against anything.
///
/// Only for Wayland on Linux.
#[napi]
pub fn on_layer_surface_output(
    env: Env,
    #[napi(ts_arg_type = "(windowId: string, output: string) => void")] callback: Function<
        FnArgs<(String, String)>,
        (),
    >,
) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        use crate::linux::on_layer_surface_output as on_layer_surface_output_impl;
        on_layer_surface_output_impl(env, callback)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = callback;
        env.throw("Only supports Linux")
    }
}

/// Record how large the output a converted window's layer surface lives on is.
///
/// A compositor never tells a client how big an output is, and a layer surface
/// cannot move to another one — so a gesture the proxy replays has no way of
/// knowing where the window would stop being reachable. Reporting the size of
/// the screen the window is on is what keeps a drag inside it, with a strip of
/// the window left on screen. Sizes are in the same logical coordinates the
/// window's policy is written in, and do nothing for a window that is not a
/// layer surface.
///
/// Only for Wayland on Linux.
#[napi]
pub fn set_window_layer_bounds(window_id: String, width: u32, height: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        linux::set_layer_bounds(window_id, width, height)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (window_id, width, height);
        false
    }
}

/// Change the size a converted window's layer surface asks for.
///
/// A layer surface's size belongs to the application, and the client cannot ask
/// for one itself: a buffer of another size attached to a surface the
/// compositor keeps at the size it was told would mismatch it. The request is
/// applied at the window's next commit, like every double-buffered surface
/// state, and does nothing for a window that is not a layer surface.
///
/// Only for Wayland on Linux.
#[napi]
pub fn set_window_layer_size(window_id: String, width: u32, height: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        linux::set_layer_size(window_id, width, height)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (window_id, width, height);
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

/// Register (or clear) the layer-shell policy for a managed window.
///
/// The policy is keyed by the id the application names the window with, so it
/// may be registered before the window — or its surface — exists. It is read
/// once, when the proxy resolves a surface's window id from the decorated
/// title: a surface that has not taken a role yet becomes a layer surface with
/// these options, and a surface that is already an ordinary toplevel can never
/// become one.
///
/// Returns whether the policy was accepted; `None` clears the policy. Refused
/// options are not stored, and the window is still created as an ordinary one.
#[napi]
pub fn set_window_layer_shell(window_id: String, options: Option<LayerShellOptions>) -> bool {
    #[cfg(target_os = "linux")]
    {
        match options {
            Some(options) => crate::linux::set_layer_policy(&window_id, &options),
            None => crate::linux::clear_layer_policy(&window_id),
        }
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = window_id;
        options.is_none()
    }
}

/// Re-key the native state recorded for one managed window under another.
///
/// A policy switch replaces the wrapper, and the replacement is a different
/// window with a different id. The layer-shell policy and the recorded input
/// region follow it, so nothing has to be mirrored on the application side.
#[napi]
pub fn transfer_window_state(from_id: String, to_id: String) -> bool {
    #[cfg(target_os = "linux")]
    {
        crate::linux::transfer_window_state(&from_id, &to_id)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (from_id, to_id);
        false
    }
}

/// Release the native state recorded for a window that will not return.
///
/// The layer-shell policy and the recorded input region are dropped, so a
/// discarded wrapper cannot leave them behind. Do not call this for a window
/// that merely hides and is shown again: it keeps its id and needs the record.
#[napi]
pub fn forget_window_state(window_id: String) -> bool {
    #[cfg(target_os = "linux")]
    {
        crate::linux::forget_window_state(&window_id)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = window_id;
        false
    }
}

/// Whether a layer-shell policy could be sent.
///
/// The same option validation `setWindowLayerShell` applies, without storing
/// anything: callers can report options that could never be sent, and a
/// settings UI can check a choice before anything is created.
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

// endregion
