mod codec;
mod filter;
mod handlers;
mod inject;
mod layer_shell;
mod state;

#[cfg(test)]
mod test_support;

use std::os::fd::RawFd;
use std::sync::{Arc, Mutex};

use crate::linux::Rect;

use super::proxy::{Cmsg, ConnectionHandler, Direction, Filtered, Protocol};

pub(super) use layer_shell::{
    ANCHOR_BOTTOM, ANCHOR_LEFT, ANCHOR_RIGHT, ANCHOR_TOP, KEYBOARD_NONE, LAYER_BACKGROUND,
    LAYER_BOTTOM, LAYER_OVERLAY, LAYER_TOP, LayerShellOptions,
};

pub(super) fn is_wayland() -> bool {
    state::is_wayland()
}

pub(super) fn is_layer_shell_available() -> bool {
    state::is_layer_shell_available()
}

/// Register (or replace) the layer-shell policy for a managed window.
///
/// Validates the options first: a declaration the compositor would answer with
/// a protocol error must never reach the wire.
pub(super) fn set_layer_policy(window_id: &str, options: LayerShellOptions) -> bool {
    let options = options.with_defaults();
    if options.validate().is_err() {
        return false;
    }
    state::set_layer_policy(window_id, options)
}

/// Withdraw the layer-shell policy for a managed window.
pub(super) fn clear_layer_policy(window_id: &str) -> bool {
    state::clear_layer_policy(window_id)
}

/// Re-key everything the proxy knows about a window under another window id.
pub(super) fn transfer_window_state(from_id: &str, to_id: &str) -> bool {
    let role = state::transfer_window_role(from_id, to_id);
    let region = inject::transfer_input_region(from_id, to_id);
    role && region
}

/// Release everything the proxy recorded for a window that will not return.
///
/// Distinct from [`transfer_window_state`]: the window keeps nothing, so a
/// discarded wrapper cannot leave policy or region records behind.
pub(super) fn forget_window_state(window_id: &str) -> bool {
    state::clear_window_role(window_id);
    inject::forget_input_region(window_id);
    true
}

/// Whether `options` survive the defaults and the protocol's rules.
///
/// The same checks `set_layer_policy` applies, without storing anything: a
/// caller can be told its options are unsendable before a window exists to
/// attach them to.
pub(super) fn validate_layer_window(options: LayerShellOptions) -> bool {
    options.with_defaults().validate().is_ok()
}

/// Decorate a title with the managed window id the proxy keys windows on.
pub(super) fn decorate_title(id: &str, title: &str) -> String {
    codec::decorate_title(id, title)
}

/// Register the listener that hears about windows whose layer role was refused.
pub(super) fn on_layer_shell_refused(cb: state::LayerShellRefusedCb) -> bool {
    state::on_layer_shell_refused(cb)
}

pub(super) fn send_xdg_toplevel_move() -> bool {
    inject::send_xdg_toplevel_move()
}

pub(super) fn set_input_region_rects(window_id: &str, rects: Option<&[Rect]>) -> bool {
    inject::set_input_region_rects(window_id, rects)
}

pub(super) fn set_popup_policy(
    target_window_id: &str,
    parent_window_id: &str,
    width: i32,
    height: i32,
    anchor: Option<(i32, i32)>,
    shadow_inset: i32,
) -> bool {
    state::set_popup_policy(
        target_window_id,
        parent_window_id,
        width,
        height,
        anchor,
        shadow_inset,
    )
}

pub(super) fn set_layer_size(window_id: &str, width: u32, height: u32) -> bool {
    inject::set_layer_size(window_id, width, height)
}

pub(super) fn set_layer_bounds(window_id: &str, width: u32, height: u32) -> bool {
    state::set_layer_bounds(window_id, width, height)
}

pub(super) fn on_layer_output(cb: state::LayerOutputCb) -> bool {
    state::on_layer_output(cb)
}

pub(super) fn on_layer_pushed(cb: state::LayerPushedCb) -> bool {
    state::on_layer_pushed(cb)
}

pub(super) fn on_layer_geometry(cb: state::LayerGeometryCb) -> bool {
    state::on_layer_geometry(cb)
}

pub(super) fn clear_popup_policy(target_window_id: &str) -> bool {
    state::clear_popup_policy(target_window_id)
}

pub(super) fn window_is_popup(window_id: &str) -> bool {
    state::window_is_popup(window_id)
}

/// How long ago the most recent pointer press landed in `window_id`.
pub(super) fn window_last_press_age_ms(window_id: &str) -> Option<u32> {
    state::window_last_press_age(window_id).map(|age| age.as_millis() as u32)
}

/// Whether a pointer is currently over `window_id`'s surface.
pub(super) fn window_pointer_inside(window_id: &str) -> bool {
    state::window_pointer_inside(window_id)
}

pub(super) fn on_next_pointer_axis(
    window_id: &str,
    cb: impl FnOnce(Option<u32>) + Send + 'static,
) -> Option<u32> {
    state::watch_next_pointer_axis(window_id, Box::new(cb))
}

pub(super) fn cancel_pointer_axis_watcher(token: u32) -> bool {
    state::cancel_pointer_axis_watcher(token)
}

pub(super) fn on_next_new_window_first_cursor_enter(
    cb: impl FnOnce(Option<(i32, i32)>) + Send + 'static,
) -> Option<u32> {
    state::watch_next_toplevel_cursor_enter(Box::new(cb))
}

pub(super) fn cancel_cursor_enter_watcher(token: u32) -> bool {
    state::cancel_cursor_enter_watcher(token)
}

pub(crate) fn init_state() {
    state::init_state();
}

pub(crate) fn clear_state() {
    state::clear_state();
}

fn on_new_connection(fd: RawFd) {
    state::IS_WAYLAND.set(true).ok();
    if let Some(m) = state::CONNS.get()
        && let Ok(mut map) = m.lock()
    {
        map.entry(fd).or_insert_with(state::WaylandConn::new);
    }
}

// ── Protocol registration ─────────────────────────────────────────────────

pub(crate) struct WaylandProtocol;

impl Protocol for WaylandProtocol {
    fn matches(&self, addr: *const libc::c_void, addrlen: u32) -> bool {
        codec::is_wayland_socket(addr, addrlen)
    }

    fn spawn(&self, app_fd: RawFd, _real_fd: RawFd) -> Box<dyn ConnectionHandler> {
        on_new_connection(app_fd);
        Box::new(WaylandHandler {
            fd: app_fd,
            write_lock: Arc::new(Mutex::new(())),
        })
    }
}

struct WaylandHandler {
    fd: RawFd,
    write_lock: Arc<Mutex<()>>,
}

impl ConnectionHandler for WaylandHandler {
    fn filter(&mut self, dir: Direction, chunk: &[u8], cmsg: Option<Cmsg>) -> Option<Filtered> {
        filter::filter(self.fd, dir, chunk, cmsg)
    }

    fn on_close(&mut self) {
        state::on_close(self.fd);
    }

    /// Serializes direct server-bound writes with the proxy's own forwarding.
    ///
    /// Synthesised layer-shell state (an emulated drag, a size the application
    /// asked for) bypasses the filter — the id means something else to the
    /// client — so it is written straight to the compositor and has to be kept
    /// from interleaving with a forwarded chunk.
    fn write_lock(&self) -> Option<Arc<Mutex<()>>> {
        Some(Arc::clone(&self.write_lock))
    }
}
