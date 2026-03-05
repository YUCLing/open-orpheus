// Use #[neon::export] to export Rust functions as JavaScript functions.
// See more at: https://docs.rs/neon/latest/neon/attr.export.html

use neon::prelude::Context;
#[cfg(windows)]
use neon::{
    handle::Handle,
    prelude::Cx,
    result::NeonResult,
    types::{JsBuffer, buffer::TypedArray},
};

#[cfg(windows)]
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

// TODO: Linux support (Wayland then X11)
// https://wayland.app/protocols/xdg-shell#xdg_toplevel:request:move

// Use #[neon::main] to add additional behavior at module loading time.
// See more at: https://docs.rs/neon/latest/neon/attr.main.html

// #[neon::main]
// fn main(_cx: ModuleContext) -> NeonResult<()> {
//     println!("module is loaded!");
//     Ok(())
// }
