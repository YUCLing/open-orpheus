mod codec;
mod filter;
mod handlers;
mod inject;
mod state;

use std::os::fd::RawFd;
use std::sync::{Arc, Mutex};

use crate::linux::Rect;

use super::proxy::{Cmsg, ConnectionHandler, Direction, Filtered, Protocol, Sink};

pub(super) fn is_x11() -> bool {
    state::is_x11()
}

pub(super) fn send_net_wm_moveresize_move(window: u32) -> bool {
    let Some(handle) = X11Handle::active() else {
        return false;
    };
    handle
        .with_state(|conn, sink| inject::move_window(conn, sink, window))
        .unwrap_or(false)
}

pub(super) fn set_input_region_rects(window: u32, rects: Option<&[Rect]>) -> bool {
    let Some(handle) = X11Handle::active() else {
        return false;
    };
    handle
        .with_state(|conn, sink| inject::set_input_region(conn, sink, window, rects))
        .unwrap_or(false)
}

/// Put `window` in the desktop layer (see [`inject::set_window_as_background`]).
pub(super) fn set_window_as_background(window: u32) -> bool {
    let Some(handle) = X11Handle::active() else {
        return false;
    };
    handle
        .with_state(|conn, sink| inject::set_window_as_background(conn, sink, window))
        .unwrap_or(false)
}

pub(super) fn query_pointer(window: u32) -> Option<(i16, i16)> {
    inject::query_pointer(window)
}

pub(crate) fn init_state() {
    state::init_state();
}

pub(crate) fn clear_state() {
    state::clear_state();
}

fn on_new_connection(fd: RawFd) {
    state::update_last_active_fd(fd);
    state::IS_X11.set(true).ok();
    if let Some(m) = state::X11_CONNS.get()
        && let Ok(mut map) = m.lock()
    {
        map.insert(fd, state::X11Conn::new());
    }
}

/// Handle to the active X11 connection, used by the public injection APIs.
pub(crate) struct X11Handle {
    fd: RawFd,
    sink: Sink,
}

impl X11Handle {
    pub(crate) fn active() -> Option<Self> {
        let fd = state::last_active_fd()?;
        let sink = super::proxy::sink_for(fd)?;
        Some(Self { fd, sink })
    }

    /// Run `f` while holding the write lock and the connection state mutex,
    /// preserving the write_lock → X11_CONNS lock order.
    pub(crate) fn with_state<T>(
        &self,
        f: impl FnOnce(&mut state::X11Conn, &Sink) -> T,
    ) -> Option<T> {
        let _guard = self.sink.write_lock.as_ref()?.lock().ok()?;
        let m = state::X11_CONNS.get()?;
        let mut map = m.lock().ok()?;
        let conn = map.get_mut(&self.fd)?;
        Some(f(conn, &self.sink))
    }
}

// ── Protocol registration ─────────────────────────────────────────────────

pub(crate) struct X11Protocol;

impl Protocol for X11Protocol {
    fn matches(&self, addr: *const libc::c_void, addrlen: u32) -> bool {
        codec::is_x11_socket(addr, addrlen)
    }

    fn spawn(&self, app_fd: RawFd, _real_fd: RawFd) -> Box<dyn ConnectionHandler> {
        on_new_connection(app_fd);
        Box::new(X11Handler { fd: app_fd })
    }
}

struct X11Handler {
    fd: RawFd,
}

impl ConnectionHandler for X11Handler {
    fn filter(&mut self, dir: Direction, chunk: &[u8], cmsg: Option<Cmsg>) -> Option<Filtered> {
        match dir {
            Direction::Outbound => filter::feed_outbound(self.fd, chunk, cmsg),
            Direction::Inbound => filter::feed_inbound(self.fd, chunk, cmsg),
        }
    }

    fn on_close(&mut self) {
        state::on_close(self.fd);
    }

    fn write_lock(&self) -> Option<Arc<Mutex<()>>> {
        state::server_write_lock(self.fd)
    }
}
