use std::{
    collections::{HashMap, HashSet},
    os::fd::RawFd,
    sync::{Mutex, OnceLock},
};

use super::codec::Iface;

// ── Per-connection tracking state ──────────────────────────────────────────

pub(crate) struct WaylandConn {
    pub(crate) ifaces: HashMap<u32, Iface>,
    pub(crate) pointer_focus: HashMap<u32, u32>,
    pub(crate) pointer_position: HashMap<u32, (i32, i32)>,
    pub(crate) pointer_seat: HashMap<u32, u32>,
    pub(crate) xdg_to_wl: HashMap<u32, u32>,
    pub(crate) wl_to_top: HashMap<u32, u32>,
    pub(crate) top_to_xdg: HashMap<u32, u32>,
    pub(crate) compositor_id: Option<u32>,
    pub(crate) xdg_wm_base_id: Option<u32>,
    pub(crate) injected_ids: HashSet<u32>,
    pub(crate) stolen_ids: Vec<u32>,
}

impl WaylandConn {
    pub(crate) fn new() -> Self {
        let mut ifaces = HashMap::new();
        ifaces.insert(1u32, Iface::WlDisplay);
        Self {
            ifaces,
            pointer_focus: HashMap::new(),
            pointer_position: HashMap::new(),
            pointer_seat: HashMap::new(),
            xdg_to_wl: HashMap::new(),
            wl_to_top: HashMap::new(),
            top_to_xdg: HashMap::new(),
            compositor_id: None,
            xdg_wm_base_id: None,
            injected_ids: HashSet::new(),
            stolen_ids: Vec::new(),
        }
    }

    pub(crate) fn reset_tracking(&mut self) {
        self.ifaces.clear();
        self.ifaces.insert(1u32, Iface::WlDisplay);
        self.pointer_focus.clear();
        self.pointer_position.clear();
        self.pointer_seat.clear();
        self.xdg_to_wl.clear();
        self.wl_to_top.clear();
        self.top_to_xdg.clear();
        self.compositor_id = None;
        self.xdg_wm_base_id = None;
        self.injected_ids.clear();
        self.stolen_ids.clear();
    }

    pub(crate) fn alloc_injected_id(&mut self) -> Option<u32> {
        let id = self.stolen_ids.pop()?;
        self.injected_ids.insert(id);
        Some(id)
    }

    pub(crate) fn purge(&mut self, id: u32) {
        match self.ifaces.get(&id).copied() {
            Some(Iface::WlPointer) => {
                self.pointer_focus.remove(&id);
                self.pointer_position.remove(&id);
                self.pointer_seat.remove(&id);
            }
            Some(Iface::WlSurface) => {
                self.xdg_to_wl.retain(|_, v| *v != id);
                self.wl_to_top.remove(&id);
                self.pointer_focus.retain(|_, v| *v != id);
            }
            Some(Iface::XdgSurface) => {
                let owned_top = self
                    .top_to_xdg
                    .iter()
                    .find(|(_, v)| **v == id)
                    .map(|(k, _)| *k);
                if let Some(tid) = owned_top {
                    self.purge(tid);
                }
                self.xdg_to_wl.remove(&id);
            }
            Some(Iface::XdgToplevel | Iface::XdgPopupShim) => {
                self.top_to_xdg.remove(&id);
                self.wl_to_top.retain(|_, v| *v != id);
            }
            Some(Iface::WlSeat) => {
                self.pointer_seat.retain(|_, v| *v != id);
            }
            _ => {}
        }
        self.ifaces.remove(&id);
    }

    pub(crate) fn wl_surface_for_window_object(&self, id: u32, iface: Iface) -> Option<u32> {
        match iface {
            Iface::WlSurface => Some(id),
            Iface::XdgSurface => self.xdg_to_wl.get(&id).copied(),
            Iface::XdgToplevel | Iface::XdgPopupShim => self
                .top_to_xdg
                .get(&id)
                .and_then(|xdg_id| self.xdg_to_wl.get(xdg_id))
                .copied(),
            _ => None,
        }
    }
}

// ── Global state ───────────────────────────────────────────────────────────

pub(crate) static IS_WAYLAND: OnceLock<bool> = OnceLock::new();
pub(crate) static CONNS: OnceLock<Mutex<HashMap<RawFd, WaylandConn>>> = OnceLock::new();
#[allow(clippy::type_complexity)]
#[derive(Clone, Copy)]
pub(crate) struct LastButton {
    pub(crate) fd: RawFd,
    pub(crate) seat_id: u32,
    pub(crate) serial: u32,
    pub(crate) wl_surface_id: u32,
    pub(crate) x: i32,
    pub(crate) y: i32,
}

pub(crate) struct PendingPopup {
    pub(crate) fd: RawFd,
    pub(crate) parent_xdg_surface_id: u32,
    pub(crate) width: i32,
    pub(crate) height: i32,
    pub(crate) anchor_x: i32,
    pub(crate) anchor_y: i32,
    pub(crate) positioner_id: u32,
}

pub(crate) static LAST_BUTTON: OnceLock<Mutex<Option<LastButton>>> = OnceLock::new();
pub(crate) static PENDING_POPUPS: OnceLock<Mutex<Vec<PendingPopup>>> = OnceLock::new();
pub(crate) type PointerAxisCb = Box<dyn FnOnce() + Send>;
pub(crate) static NEXT_POINTER_AXIS: OnceLock<Mutex<HashMap<RawFd, Vec<PointerAxisCb>>>> =
    OnceLock::new();
pub(crate) static RX_BUFS: OnceLock<Mutex<HashMap<RawFd, Vec<u8>>>> = OnceLock::new();
pub(crate) static TX_BUFS: OnceLock<Mutex<HashMap<RawFd, Vec<u8>>>> = OnceLock::new();

#[derive(Default)]
pub(crate) struct PendingControl {
    pub(crate) bytes: Vec<u8>,
    pub(crate) fds: Vec<RawFd>,
}

pub(crate) fn close_pending_control(pending: PendingControl) {
    for fd in pending.fds {
        super::super::proxy::syscalls::call_close(fd);
    }
}

// Pending control data (SCM_RIGHTS) stored alongside incomplete messages.
// Control data is semantically attached to a specific Wayland message on the same
// recvmsg boundary, so it must not be forwarded without the complete message.
pub(crate) static RX_PENDING_CTRL: OnceLock<Mutex<HashMap<RawFd, PendingControl>>> =
    OnceLock::new();
pub(crate) static TX_PENDING_CTRL: OnceLock<Mutex<HashMap<RawFd, PendingControl>>> =
    OnceLock::new();

// Custom window ID map tracking user-assigned IDs via setTitle("\u{200B}\u{200C}<id>")
pub(crate) static CUSTOM_ID_MAP: OnceLock<Mutex<HashMap<String, (RawFd, u32)>>> = OnceLock::new();

pub(crate) type CursorEnterCb = Box<dyn FnOnce(i32, i32) + Send>;
pub(crate) type CursorEnterWatcherKey = (RawFd, u32);
pub(crate) type CursorEnterWatcherMap = HashMap<CursorEnterWatcherKey, Vec<CursorEnterCb>>;
pub(crate) static NEXT_TOPLEVEL_CURSOR_ENTER: OnceLock<Mutex<Vec<CursorEnterCb>>> = OnceLock::new();
pub(crate) static CURSOR_ENTER_WATCHERS: OnceLock<Mutex<CursorEnterWatcherMap>> = OnceLock::new();

// ── Cursor enter watchers ─────────────────────────────────────────────────

pub(crate) fn arm_first_cursor_enter_watchers(fd: RawFd, wl_surface_id: u32) {
    let Some(pending) = NEXT_TOPLEVEL_CURSOR_ENTER.get() else {
        return;
    };
    let Ok(mut pending) = pending.lock() else {
        return;
    };
    if pending.is_empty() {
        return;
    }
    let callbacks: Vec<_> = pending.drain(..).collect();
    drop(pending);
    if let Some(watchers) = CURSOR_ENTER_WATCHERS.get()
        && let Ok(mut watchers) = watchers.lock()
    {
        watchers
            .entry((fd, wl_surface_id))
            .or_default()
            .extend(callbacks);
    }
}

pub(crate) fn fire_first_cursor_enter_watchers(fd: RawFd, wl_surface_id: u32, x: i32, y: i32) {
    let Some(watchers) = CURSOR_ENTER_WATCHERS.get() else {
        return;
    };
    let callbacks = {
        let Ok(mut watchers) = watchers.lock() else {
            return;
        };
        watchers.remove(&(fd, wl_surface_id))
    };
    if let Some(callbacks) = callbacks {
        for callback in callbacks {
            callback(x, y);
        }
    }
}

pub(crate) fn clear_first_cursor_enter_watchers_for_fd(fd: RawFd) {
    if let Some(watchers) = CURSOR_ENTER_WATCHERS.get()
        && let Ok(mut watchers) = watchers.lock()
    {
        watchers.retain(|(watch_fd, _), _| *watch_fd != fd);
    }
}

pub(crate) fn arm_next_popup(
    parent_window_id: &str,
    width: i32,
    height: i32,
    anchor: Option<(i32, i32)>,
) -> bool {
    if width <= 0 || height <= 0 {
        return false;
    }
    let Some((fd, parent_wl_surface_id)) = CUSTOM_ID_MAP
        .get()
        .and_then(|map| map.lock().ok()?.get(parent_window_id).copied())
    else {
        return false;
    };
    let parent_xdg_surface_id = CONNS
        .get()
        .and_then(|conns| conns.lock().ok())
        .and_then(|conns| {
            conns
                .get(&fd)?
                .xdg_to_wl
                .iter()
                .find_map(|(xdg, wl)| (*wl == parent_wl_surface_id).then_some(*xdg))
        });
    let Some(parent_xdg_surface_id) = parent_xdg_surface_id else {
        return false;
    };

    let (anchor_x, anchor_y) = if let Some((x, y)) = anchor {
        (x, y)
    } else {
        let Some(button) = LAST_BUTTON
            .get()
            .and_then(|v| v.lock().ok())
            .and_then(|v| *v)
        else {
            return false;
        };
        if button.fd != fd || button.wl_surface_id != parent_wl_surface_id {
            return false;
        }
        (button.x, button.y)
    };

    let Some(pending) = PENDING_POPUPS.get() else {
        return false;
    };

    let positioner_id = CONNS
        .get()
        .and_then(|conns| conns.lock().ok())
        .and_then(|mut conns| conns.get_mut(&fd)?.alloc_injected_id());
    let Some(positioner_id) = positioner_id else {
        return false;
    };

    let Ok(mut pending) = pending.lock() else {
        if let Some(conns) = CONNS.get()
            && let Ok(mut conns) = conns.lock()
            && let Some(conn) = conns.get_mut(&fd)
        {
            conn.injected_ids.remove(&positioner_id);
            conn.stolen_ids.push(positioner_id);
        }
        return false;
    };
    pending.push(PendingPopup {
        fd,
        parent_xdg_surface_id,
        width,
        height,
        anchor_x,
        anchor_y,
        positioner_id,
    });
    true
}

pub(crate) fn take_pending_popup(fd: RawFd) -> Option<PendingPopup> {
    let mut pending = PENDING_POPUPS.get()?.lock().ok()?;
    let index = pending.iter().position(|popup| popup.fd == fd)?;
    Some(pending.remove(index))
}

pub(crate) fn watch_next_pointer_axis(window_id: &str, callback: PointerAxisCb) -> bool {
    let Some((fd, _)) = CUSTOM_ID_MAP
        .get()
        .and_then(|map| map.lock().ok()?.get(window_id).copied())
    else {
        return false;
    };
    let Some(watchers) = NEXT_POINTER_AXIS.get() else {
        return false;
    };
    let Ok(mut watchers) = watchers.lock() else {
        return false;
    };
    watchers.entry(fd).or_default().push(callback);
    true
}

pub(crate) fn fire_next_pointer_axis(fd: RawFd) {
    let callbacks = NEXT_POINTER_AXIS
        .get()
        .and_then(|watchers| watchers.lock().ok()?.remove(&fd));
    if let Some(callbacks) = callbacks {
        for callback in callbacks {
            callback();
        }
    }
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

pub(crate) fn on_close(fd: RawFd) {
    if let Some(m) = CONNS.get()
        && let Ok(mut map) = m.lock()
    {
        map.remove(&fd);
    }
    if let Some(m) = LAST_BUTTON.get()
        && let Ok(mut opt) = m.lock()
        && opt.is_some_and(|button| button.fd == fd)
    {
        *opt = None;
    }
    if let Some(m) = RX_BUFS.get() {
        let _ = m.lock().map(|mut g| g.remove(&fd));
    }
    if let Some(m) = TX_BUFS.get() {
        let _ = m.lock().map(|mut g| g.remove(&fd));
    }
    if let Some(m) = RX_PENDING_CTRL.get()
        && let Ok(mut g) = m.lock()
        && let Some(pending) = g.remove(&fd)
    {
        close_pending_control(pending);
    }
    if let Some(m) = TX_PENDING_CTRL.get()
        && let Ok(mut g) = m.lock()
        && let Some(pending) = g.remove(&fd)
    {
        close_pending_control(pending);
    }
    if let Some(m) = CUSTOM_ID_MAP.get()
        && let Ok(mut map) = m.lock()
    {
        map.retain(|_, v| v.0 != fd);
    }
    if let Some(m) = NEXT_POINTER_AXIS.get()
        && let Ok(mut watchers) = m.lock()
    {
        watchers.remove(&fd);
    }
    clear_first_cursor_enter_watchers_for_fd(fd);
}

pub(crate) fn is_wayland() -> bool {
    *IS_WAYLAND.get().unwrap_or(&false)
}

pub(crate) fn init_state() {
    CONNS.get_or_init(|| Mutex::new(HashMap::new()));
    LAST_BUTTON.get_or_init(|| Mutex::new(None));
    PENDING_POPUPS.get_or_init(|| Mutex::new(Vec::new()));
    NEXT_POINTER_AXIS.get_or_init(|| Mutex::new(HashMap::new()));
    CUSTOM_ID_MAP.get_or_init(|| Mutex::new(HashMap::new()));
    RX_BUFS.get_or_init(|| Mutex::new(HashMap::new()));
    TX_BUFS.get_or_init(|| Mutex::new(HashMap::new()));
    RX_PENDING_CTRL.get_or_init(|| Mutex::new(HashMap::new()));
    TX_PENDING_CTRL.get_or_init(|| Mutex::new(HashMap::new()));
    NEXT_TOPLEVEL_CURSOR_ENTER.get_or_init(|| Mutex::new(Vec::new()));
    CURSOR_ENTER_WATCHERS.get_or_init(|| Mutex::new(HashMap::new()));
}

pub(crate) fn clear_state() {
    if let Some(m) = CONNS.get()
        && let Ok(mut map) = m.lock()
    {
        map.clear();
    }
    if let Some(m) = LAST_BUTTON.get()
        && let Ok(mut opt) = m.lock()
    {
        *opt = None;
    }
    if let Some(m) = PENDING_POPUPS.get()
        && let Ok(mut pending) = m.lock()
    {
        pending.clear();
    }
    if let Some(m) = NEXT_POINTER_AXIS.get()
        && let Ok(mut watchers) = m.lock()
    {
        watchers.clear();
    }
    if let Some(m) = CUSTOM_ID_MAP.get()
        && let Ok(mut map) = m.lock()
    {
        map.clear();
    }
    if let Some(m) = RX_BUFS.get()
        && let Ok(mut map) = m.lock()
    {
        map.clear();
    }
    if let Some(m) = TX_BUFS.get()
        && let Ok(mut map) = m.lock()
    {
        map.clear();
    }
    if let Some(m) = RX_PENDING_CTRL.get()
        && let Ok(mut map) = m.lock()
    {
        for pending in map.drain().map(|(_, pending)| pending) {
            close_pending_control(pending);
        }
    }
    if let Some(m) = TX_PENDING_CTRL.get()
        && let Ok(mut map) = m.lock()
    {
        for pending in map.drain().map(|(_, pending)| pending) {
            close_pending_control(pending);
        }
    }
    if let Some(m) = NEXT_TOPLEVEL_CURSOR_ENTER.get()
        && let Ok(mut cbs) = m.lock()
    {
        cbs.clear();
    }
    if let Some(m) = CURSOR_ENTER_WATCHERS.get()
        && let Ok(mut watchers) = m.lock()
    {
        watchers.clear();
    }
}
