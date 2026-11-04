use napi::{Env, Error, Result, bindgen_prelude::Buffer};
use napi_derive::napi;
use windows::{
    Win32::{
        Foundation::{HWND, LPARAM, POINT, WPARAM},
        Graphics::Gdi::{
            GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MapWindowPoints,
            MonitorFromWindow,
        },
        UI::{
            Input::KeyboardAndMouse::ReleaseCapture,
            WindowsAndMessaging::{
                EnumWindows, FindWindowExW, FindWindowW, GWL_EXSTYLE, GWL_STYLE, GetWindowLongW,
                HTCAPTION, HWND_BOTTOM, SC_MOVE, SMTO_NORMAL, SWP_NOACTIVATE, SendMessageTimeoutW,
                SendMessageW, SetParent, SetWindowLongW, SetWindowPos, WM_SYSCOMMAND, WS_CHILD,
                WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_OVERLAPPEDWINDOW, WS_POPUP,
            },
        },
    },
    core::{BOOL, w},
};

mod display;

#[napi]
pub fn drag_window(env: Env, hwnd: Buffer) -> Result<()> {
    if hwnd.len() != std::mem::size_of::<isize>() {
        return env.throw("Invalid buffer size for window handle");
    }
    let hwnd = isize::from_ne_bytes(hwnd.as_ref().try_into().unwrap());
    let hwnd = HWND(hwnd as _);
    unsafe {
        ReleaseCapture().unwrap();
        SendMessageW(
            hwnd,
            WM_SYSCOMMAND,
            Some(WPARAM((SC_MOVE | HTCAPTION) as _)),
            Some(LPARAM(0)),
        );
    }
    Ok(())
}

#[napi]
pub fn set_window_as_background(env: Env, hwnd: Buffer, display_id: Option<u32>) -> Result<()> {
    if hwnd.len() != std::mem::size_of::<isize>() {
        return env.throw("Invalid buffer size for window handle");
    }
    let hwnd = isize::from_ne_bytes(hwnd.as_ref().try_into().unwrap());
    let hwnd = HWND(hwnd as _);

    // Resolve the caller's display id; without one — or when the topology
    // changed before the call — fall back to the monitor the window is on.
    let monitor = display_id
        .and_then(display::monitor_from_display)
        .unwrap_or_else(|| unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) });

    let mut monitor_info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !unsafe { GetMonitorInfoW(monitor, &mut monitor_info) }.as_bool() {
        return Err(Error::from_reason(
            windows::core::Error::from_thread().message(),
        ));
    }
    let screen_rect = monitor_info.rcMonitor;

    let progman =
        unsafe { FindWindowW(w!("Progman"), None).map_err(|x| Error::from_reason(x.message()))? };

    // Send the undocumented message to spawn a WorkerW behind the desktop icons.
    // If one already exists, this message is a no-op.
    unsafe {
        SendMessageTimeoutW(
            progman,
            0x052C,
            WPARAM(0x0000000D),
            LPARAM(0x00000001),
            SMTO_NORMAL,
            1000,
            None,
        );
    }

    // Enumerate top-level windows to find the correct WorkerW.
    // We are looking for the WorkerW that is a sibling of the window
    // containing SHELLDLL_DefView (the desktop icons).
    let mut workerw = HWND::default();
    unsafe {
        EnumWindows(
            Some(enum_windows_proc),
            LPARAM(&mut workerw as *mut HWND as isize),
        )
        .map_err(|x| Error::from_reason(x.message()))?;
    }

    // If enumeration failed, try finding a direct child WorkerW of Progman.
    if workerw.is_invalid() {
        workerw =
            unsafe { FindWindowExW(Some(progman), None, w!("WorkerW"), None) }.unwrap_or_default();
    }

    if workerw.is_invalid() {
        return Err(Error::from_reason(
            windows::core::Error::from_thread().message(),
        ));
    }

    // Adjust window styles so it behaves as a child of the WorkerW.
    let style = unsafe { GetWindowLongW(hwnd, GWL_STYLE) } as u32;
    let new_style = (style & !(WS_POPUP.0 | WS_OVERLAPPEDWINDOW.0)) | WS_CHILD.0;
    unsafe { SetWindowLongW(hwnd, GWL_STYLE, new_style as i32) };

    // Remove taskbar presence and prevent activation.
    let ex_style = unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) } as u32;
    let new_ex_style = (ex_style & !WS_EX_APPWINDOW.0) | WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0;
    unsafe { SetWindowLongW(hwnd, GWL_EXSTYLE, new_ex_style as i32) };

    unsafe { SetParent(hwnd, Some(workerw)).map_err(|x| Error::from_reason(x.message()))? };

    // `rcMonitor` is in screen coordinates, but a child window is positioned in
    // its parent's client coordinates. The WorkerW covers the whole virtual
    // screen, yet its client origin is only (0, 0) when no monitor sits left of
    // or above the primary one; otherwise placing the window at 0, 0 puts it on
    // the primary monitor instead of the target. Ask Windows to map the rect
    // through the parent instead of assuming that origin.
    let mut corners = [
        POINT {
            x: screen_rect.left,
            y: screen_rect.top,
        },
        POINT {
            x: screen_rect.right,
            y: screen_rect.bottom,
        },
    ];
    unsafe { MapWindowPoints(None, Some(workerw), &mut corners) };

    unsafe {
        SetWindowPos(
            hwnd,
            Some(HWND_BOTTOM),
            corners[0].x,
            corners[0].y,
            corners[1].x - corners[0].x,
            corners[1].y - corners[0].y,
            SWP_NOACTIVATE,
        )
        .map_err(|x| Error::from_reason(x.message()))?;
    }

    Ok(())
}

unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // Check if this window contains the SHELLDLL_DefView (desktop icons).
    let shell_view = unsafe {
        FindWindowExW(Some(hwnd), None, w!("SHELLDLL_DefView"), None).unwrap_or_default()
    };

    if !shell_view.is_invalid() {
        // Found the window containing the icons.
        // The WorkerW we want is the next window in Z-order (below the icons).
        let workerw =
            unsafe { FindWindowExW(None, Some(hwnd), w!("WorkerW"), None).unwrap_or_default() };

        if !workerw.is_invalid() {
            // Write the found HWND back to the pointer passed via lparam.
            unsafe { *(lparam.0 as *mut HWND) = workerw };
            return false.into(); // Stop enumeration.
        }
    }

    true.into() // Continue enumeration.
}

/// The compositor's unique name for the output Electron reports as a `Display.id`.
///
/// On Linux, this is the `wl_output.name` event (for example `DP-1`), looked up
/// across the live Wayland connections. `null` when none of them knows the display,
/// the client has not bound it yet, or the compositor is too old to send a name.
///
/// On the other platforms, this is a ID that will be consistent across sessions.
#[napi]
pub fn get_unique_display_id(display_id: u32) -> Result<Option<String>> {
    display::stable_monitor_id(display_id)
}
