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

// endregion
