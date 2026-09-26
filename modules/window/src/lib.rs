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
/// Applied to the next toplevel the display connection creates, so it has to be
/// declared before the window (or its surface) is brought into existence. A
/// declaration that says nothing about size or anchors covers the output.
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

/// Listen for first CursorEnter event of the next created window.
///
/// Only for Wayland on Linux.
#[napi]
pub fn capture_next_window_first_cursor_enter(
    env: Env,
    #[napi(ts_arg_type = "(x: number, y: number) => void")] callback: Function<
        FnArgs<(i32, i32)>,
        (),
    >,
) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        use crate::linux::capture_next_window_first_cursor_enter as capture_next_window_first_cursor_enter_impl;
        capture_next_window_first_cursor_enter_impl(env, callback)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = callback;
        env.throw("Only supports Linux")
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
#[napi]
pub fn use_layer_shell_for_next_window(options: LayerShellOptions) -> bool {
    #[cfg(target_os = "linux")]
    {
        crate::linux::declare_layer_window(&options)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = options;
        false
    }
}

/// Whether a layer-shell declaration would be accepted.
///
/// The same validation `useLayerShellForNextWindow` applies, without queueing
/// anything: callers can report a declaration that could never be sent, and a
/// settings UI can check a choice before anything is created. `false` also
/// means the compositor cannot take layer surfaces at all.
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

/// Withdraw a layer-shell declaration that has not been consumed yet.
#[napi]
pub fn cancel_layer_shell_for_next_window() -> bool {
    #[cfg(target_os = "linux")]
    {
        crate::linux::cancel_layer_window()
    }

    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

// endregion
