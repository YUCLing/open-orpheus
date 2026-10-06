use napi::{Env, Error, Result, bindgen_prelude::Buffer};
use napi_derive::napi;
use windows::{
    Win32::{
        Foundation::{HWND, LPARAM, WPARAM},
        UI::{
            Input::KeyboardAndMouse::ReleaseCapture,
            WindowsAndMessaging::{
                EnumWindows, FindWindowExW, FindWindowW, GWL_EXSTYLE, GWL_STYLE, GetSystemMetrics,
                GetWindowLongW, HTCAPTION, HWND_BOTTOM, SC_MOVE, SM_CXSCREEN, SM_CYSCREEN,
                SMTO_NORMAL, SWP_NOACTIVATE, SendMessageTimeoutW, SendMessageW, SetParent,
                SetWindowLongW, SetWindowPos, WM_SYSCOMMAND, WS_CHILD, WS_EX_APPWINDOW,
                WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_OVERLAPPEDWINDOW, WS_POPUP,
            },
        },
    },
    core::{BOOL, w},
};

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
pub fn set_window_as_background(env: Env, hwnd: Buffer) -> Result<()> {
    if hwnd.len() != std::mem::size_of::<isize>() {
        return env.throw("Invalid buffer size for window handle");
    }
    let hwnd = isize::from_ne_bytes(hwnd.as_ref().try_into().unwrap());
    let hwnd = HWND(hwnd as _);

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

    let screen_w = unsafe { GetSystemMetrics(SM_CXSCREEN) };
    let screen_h = unsafe { GetSystemMetrics(SM_CYSCREEN) };

    unsafe {
        SetWindowPos(
            hwnd,
            Some(HWND_BOTTOM),
            0,
            0,
            screen_w,
            screen_h,
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
