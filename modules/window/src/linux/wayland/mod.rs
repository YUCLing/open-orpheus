mod codec;
mod filter;
mod handlers;
mod inject;
mod state;

use std::os::fd::RawFd;

use crate::linux::Rect;

use super::proxy::{Cmsg, ConnectionHandler, Direction, Filtered, Protocol};

pub(super) fn is_wayland() -> bool {
    state::is_wayland()
}

pub(super) fn send_xdg_toplevel_move() -> bool {
    inject::send_xdg_toplevel_move()
}

pub(super) fn set_input_region_rects(window_id: &str, rects: Option<&[Rect]>) -> bool {
    inject::set_input_region_rects(window_id, rects)
}

pub(super) fn arm_next_window_as_popup(
    parent_window_id: &str,
    width: i32,
    height: i32,
    anchor: Option<(i32, i32)>,
) -> Option<u32> {
    state::arm_next_popup(parent_window_id, width, height, anchor)
}

pub(super) fn cancel_pending_popup(token: u32) -> bool {
    state::cancel_pending_popup(token)
}

pub(super) fn window_is_popup(window_id: &str) -> bool {
    state::window_is_popup(window_id)
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
