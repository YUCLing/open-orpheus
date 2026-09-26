mod codec;
mod filter;
mod handlers;
mod inject;
mod layer_shell;
mod state;

#[cfg(test)]
mod test_support;

use std::os::fd::RawFd;

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

/// Queue `options` for the next toplevel the client creates.
pub(super) fn declare_layer_window(options: LayerShellOptions) -> bool {
    state::declare_layer_window(options)
}

/// Whether `options` survive the defaults and the protocol's rules.
///
/// The same checks `declare_layer_window` applies, without taking a place in
/// the queue: a caller can be told its declaration is unsendable before a
/// window exists to attach it to.
pub(super) fn validate_layer_window(options: LayerShellOptions) -> bool {
    options.with_defaults().validate().is_ok()
}

/// Withdraw the newest declaration that has not been consumed yet.
pub(super) fn cancel_layer_window() -> bool {
    state::cancel_layer_window()
}

pub(super) fn send_xdg_toplevel_move() -> bool {
    inject::send_xdg_toplevel_move()
}

pub(super) fn set_input_region_rects(window_id: &str, rects: Option<&[Rect]>) -> bool {
    inject::set_input_region_rects(window_id, rects)
}

pub(super) fn on_next_new_window_first_cursor_enter(
    cb: impl FnOnce(i32, i32) + Send + 'static,
) -> bool {
    let Some(m) = state::NEXT_TOPLEVEL_CURSOR_ENTER.get() else {
        return false;
    };
    let Ok(mut cbs) = m.lock() else {
        return false;
    };
    cbs.push(Box::new(cb));
    true
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
        Box::new(WaylandHandler { fd: app_fd })
    }
}

struct WaylandHandler {
    fd: RawFd,
}

impl ConnectionHandler for WaylandHandler {
    fn filter(&mut self, dir: Direction, chunk: &[u8], cmsg: Option<Cmsg>) -> Option<Filtered> {
        filter::filter(self.fd, dir, chunk, cmsg)
    }

    fn on_close(&mut self) {
        state::on_close(self.fd);
    }
}
