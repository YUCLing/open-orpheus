use winit::window::WindowId;

use crate::app::App;

/// Focus a window.
///
/// JS signature: `focusWindow(appPtr: number, windowId: number): void`
#[neon::export]
fn focus_window(app_ptr: f64, window_id: f64) {
    let app = unsafe { &*(app_ptr as usize as *const App) };
    let id = WindowId::from(window_id as u64);
    app.focus_window(id);
}

/// Show a window.
///
/// JS signature: `showWindow(appPtr: number, windowId: number): void`
#[neon::export]
fn show_window(app_ptr: f64, window_id: f64) {
    let app = unsafe { &*(app_ptr as usize as *const App) };
    let id = WindowId::from(window_id as u64);
    app.show_window(id);
}

/// Hide a window.
///
/// JS signature: `hideWindow(appPtr: number, windowId: number): void`
#[neon::export]
fn hide_window(app_ptr: f64, window_id: f64) {
    let app = unsafe { &*(app_ptr as usize as *const App) };
    let id = WindowId::from(window_id as u64);
    app.hide_window(id);
}

/// Set or clear always-on-top for a window.
///
/// JS signature: `setAlwaysOnTop(appPtr: number, windowId: number, onTop: boolean): void`
#[neon::export]
fn set_always_on_top(app_ptr: f64, window_id: f64, on_top: bool) {
    let app = unsafe { &*(app_ptr as usize as *const App) };
    let id = WindowId::from(window_id as u64);
    app.set_always_on_top(id, on_top);
}

/// Move and resize a window (logical coordinates).
///
/// JS signature: `setWindowBounds(appPtr: number, windowId: number, x: number, y: number, width: number, height: number): void`
#[neon::export]
fn set_window_bounds(app_ptr: f64, window_id: f64, x: f64, y: f64, width: f64, height: f64) {
    let app = unsafe { &*(app_ptr as usize as *const App) };
    let id = WindowId::from(window_id as u64);
    app.set_window_bounds(
        id,
        winit::dpi::LogicalPosition::new(x, y),
        winit::dpi::LogicalSize::new(width, height),
    );
}

/// Start a drag operation on a window.
///
/// JS signature: `dragWindow(appPtr: number, windowId: number): void`
#[neon::export]
fn drag_window(app_ptr: f64, window_id: f64) {
    let app = unsafe { &*(app_ptr as usize as *const App) };
    let id = WindowId::from(window_id as u64);
    app.drag_window(id);
}
