use neon::prelude::Context;
use neon::{
    handle::Handle,
    prelude::Cx,
    result::NeonResult,
    types::{JsBuffer, buffer::TypedArray},
};

#[neon::export]
fn drag_window<'cx>(cx: &mut Cx<'cx>, hwnd: Handle<JsBuffer>) -> NeonResult<()> {
    use windows::Win32::{
        Foundation::{HWND, LPARAM, WPARAM},
        UI::WindowsAndMessaging::{HTCAPTION, SC_MOVE, WM_SYSCOMMAND},
        UI::{Input::KeyboardAndMouse::ReleaseCapture, WindowsAndMessaging::SendMessageW},
    };
    let hwnd = hwnd.as_slice(cx);
    if hwnd.len() != std::mem::size_of::<isize>() {
        let err_msg = cx.string("Invalid buffer size for window handle");
        return cx.throw(err_msg);
    }
    let hwnd = isize::from_ne_bytes(hwnd.try_into().unwrap());
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
