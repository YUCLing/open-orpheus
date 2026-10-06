use napi::{Env, Result, bindgen_prelude::Buffer};
use napi_derive::napi;
use objc2::{class, msg_send, runtime::AnyObject, sel};
use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask};
use objc2_core_graphics::{CGWindowLevelForKey, CGWindowLevelKey};
use objc2_foundation::NSPoint;

unsafe fn create_drag_event(window: *mut AnyObject) -> *mut AnyObject {
    let local: NSPoint = unsafe { msg_send![window, mouseLocationOutsideOfEventStream] };
    let now: f64 = unsafe { msg_send![class!(NSDate), timeIntervalSinceReferenceDate] };
    let window_number: isize = unsafe { msg_send![window, windowNumber] };
    unsafe {
        msg_send![class!(NSEvent),
            mouseEventWithType: 1usize,
            location: local,
            modifierFlags: 0usize,
            timestamp: now,
            windowNumber: window_number,
            context: std::ptr::null_mut::<AnyObject>(),
            eventNumber: 0isize,
            clickCount: 1isize,
            pressure: 1.0f32,
        ]
    }
}

#[napi]
pub fn drag_window(env: Env, hwnd: Buffer) -> Result<()> {
    if hwnd.len() < std::mem::size_of::<usize>() {
        return env.throw("Invalid buffer size for native handle");
    }

    let mut bytes = [0u8; std::mem::size_of::<usize>()];
    bytes.copy_from_slice(&hwnd[..std::mem::size_of::<usize>()]);
    let view = usize::from_ne_bytes(bytes) as *mut AnyObject;
    if view.is_null() {
        return env.throw("Null native pointer");
    }

    let window: *mut AnyObject = unsafe { msg_send![view, window] };
    if window.is_null() {
        return env.throw("Could not resolve NSWindow from NSView handle");
    }

    let can_drag: bool =
        unsafe { msg_send![window, respondsToSelector: sel!(performWindowDragWithEvent:)] };
    if !can_drag {
        return env.throw("performWindowDragWithEvent is unavailable on this system");
    }

    unsafe {
        let event = create_drag_event(window);
        let _: () = msg_send![window, performWindowDragWithEvent: event];
    }

    Ok(())
}

#[napi]
pub fn set_window_as_background(env: Env, hwnd: Buffer) -> Result<()> {
    if hwnd.len() < std::mem::size_of::<usize>() {
        return env.throw("Invalid buffer size for native handle");
    }

    let mut bytes = [0u8; std::mem::size_of::<usize>()];
    bytes.copy_from_slice(&hwnd[..std::mem::size_of::<usize>()]);
    let view = usize::from_ne_bytes(bytes) as *mut AnyObject;
    if view.is_null() {
        return env.throw("Null native pointer");
    }

    let window: *mut NSWindow = unsafe { msg_send![view, window] };
    if window.is_null() {
        return env.throw("Could not resolve NSWindow from NSView handle");
    }
    let window: &NSWindow = unsafe { &*window };

    // 1. Set the window level.
    // We want the window to be just above the desktop background but below
    // the desktop icons and all other normal windows.
    // kCGDesktopWindowLevelKey is the level of the wallpaper itself.
    let desktop_level = CGWindowLevelForKey(CGWindowLevelKey::DesktopWindowLevelKey);
    window.setLevel((desktop_level + 1) as isize);

    // 2. Set the collection behavior.
    // This keeps the window stationary across Spaces and prevents it from
    // being affected by Mission Control or other window management features.
    let behavior = NSWindowCollectionBehavior::CanJoinAllSpaces
        | NSWindowCollectionBehavior::Stationary
        | NSWindowCollectionBehavior::IgnoresCycle
        | NSWindowCollectionBehavior::FullScreenAuxiliary;
    window.setCollectionBehavior(behavior);

    // 3. Make the window ignore mouse events.
    // This is crucial so that clicks pass through to the desktop icons and files.
    window.setIgnoresMouseEvents(true);

    window.setStyleMask(NSWindowStyleMask::Borderless);

    if let Some(screen) = window.screen() {
        let frame = screen.frame();
        window.setFrame_display(frame, true);
    }

    Ok(())
}
