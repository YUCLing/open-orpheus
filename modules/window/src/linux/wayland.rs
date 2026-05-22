use std::{
    collections::{HashMap, HashSet},
    mem,
    os::fd::RawFd,
    sync::{Mutex, OnceLock},
};

use libc::{AF_UNIX, c_void, sa_family_t, sockaddr, sockaddr_un};

// ── Per-connection tracking state ──────────────────────────────────────────

struct WaylandConn {
    ifaces: HashMap<u32, Iface>,
    pointer_focus: HashMap<u32, u32>,
    pointer_seat: HashMap<u32, u32>,
    xdg_to_wl: HashMap<u32, u32>,
    wl_to_top: HashMap<u32, u32>,
    top_to_xdg: HashMap<u32, u32>,
    compositor_id: Option<u32>,
    injected_ids: HashSet<u32>,
    stolen_ids: Vec<u32>,
}

impl WaylandConn {
    fn new() -> Self {
        let mut ifaces = HashMap::new();
        ifaces.insert(1u32, Iface::WlDisplay);
        Self {
            ifaces,
            pointer_focus: HashMap::new(),
            pointer_seat: HashMap::new(),
            xdg_to_wl: HashMap::new(),
            wl_to_top: HashMap::new(),
            top_to_xdg: HashMap::new(),
            compositor_id: None,
            injected_ids: HashSet::new(),
            stolen_ids: Vec::new(),
        }
    }

    fn reset_tracking(&mut self) {
        self.ifaces.clear();
        self.ifaces.insert(1u32, Iface::WlDisplay);
        self.pointer_focus.clear();
        self.pointer_seat.clear();
        self.xdg_to_wl.clear();
        self.wl_to_top.clear();
        self.top_to_xdg.clear();
        self.compositor_id = None;
        self.injected_ids.clear();
        self.stolen_ids.clear();
    }

    fn alloc_injected_id(&mut self) -> Option<u32> {
        let id = self.stolen_ids.pop()?;
        self.injected_ids.insert(id);
        Some(id)
    }

    fn purge(&mut self, id: u32) {
        match self.ifaces.get(&id).copied() {
            Some(Iface::WlPointer) => {
                self.pointer_focus.remove(&id);
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
            Some(Iface::XdgToplevel) => {
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

    fn wl_surface_for_window_object(&self, id: u32, iface: Iface) -> Option<u32> {
        match iface {
            Iface::WlSurface => Some(id),
            Iface::XdgSurface => self.xdg_to_wl.get(&id).copied(),
            Iface::XdgToplevel => self
                .top_to_xdg
                .get(&id)
                .and_then(|xdg_id| self.xdg_to_wl.get(xdg_id))
                .copied(),
            _ => None,
        }
    }
}

// ── Global state ───────────────────────────────────────────────────────────

static IS_WAYLAND: OnceLock<bool> = OnceLock::new();
static CONNS: OnceLock<Mutex<HashMap<RawFd, WaylandConn>>> = OnceLock::new();
#[allow(clippy::type_complexity)]
static LAST_BUTTON: OnceLock<Mutex<Option<(RawFd, u32, u32, u32)>>> = OnceLock::new();
static RX_BUFS: OnceLock<Mutex<HashMap<RawFd, Vec<u8>>>> = OnceLock::new();
static TX_BUFS: OnceLock<Mutex<HashMap<RawFd, Vec<u8>>>> = OnceLock::new();

#[derive(Default)]
struct PendingControl {
    bytes: Vec<u8>,
    fds: Vec<RawFd>,
}

fn close_pending_control(pending: PendingControl) {
    for fd in pending.fds {
        super::hook::call_close(fd);
    }
}

// Pending control data (SCM_RIGHTS) stored alongside incomplete messages.
// Control data is semantically attached to a specific Wayland message on the same
// recvmsg boundary, so it must not be forwarded without the complete message.
static RX_PENDING_CTRL: OnceLock<Mutex<HashMap<RawFd, PendingControl>>> = OnceLock::new();
static TX_PENDING_CTRL: OnceLock<Mutex<HashMap<RawFd, PendingControl>>> = OnceLock::new();

// Custom window ID map tracking user-assigned IDs via setTitle("\u{200B}\u{200C}<id>")
static CUSTOM_ID_MAP: OnceLock<Mutex<HashMap<String, (RawFd, u32)>>> = OnceLock::new();

type CursorEnterCb = Box<dyn FnOnce(i32, i32) + Send>;
type CursorEnterWatcherKey = (RawFd, u32);
type CursorEnterWatcherMap = HashMap<CursorEnterWatcherKey, Vec<CursorEnterCb>>;
static NEXT_TOPLEVEL_CURSOR_ENTER: OnceLock<Mutex<Vec<CursorEnterCb>>> = OnceLock::new();
static CURSOR_ENTER_WATCHERS: OnceLock<Mutex<CursorEnterWatcherMap>> = OnceLock::new();

// ── Object interface tags ──────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Iface {
    WlDisplay,
    WlRegistry,
    WlCompositor,
    WlSeat,
    WlPointer,
    WlSurface,
    XdgWmBase,
    XdgSurface,
    XdgToplevel,
}

const EVT_DELETE_ID: u16 = 1;
const REQ_GET_REGISTRY: u16 = 1;
const REQ_BIND: u16 = 0;
const REQ_CREATE_SURFACE: u16 = 0;
const REQ_CREATE_REGION: u16 = 1;
const REQ_GET_POINTER: u16 = 0;
const EVT_ENTER: u16 = 0;
const EVT_LEAVE: u16 = 1;
const EVT_BUTTON: u16 = 3;
const BTN_PRESSED: u32 = 1;
const REQ_GET_XDG_SURFACE: u16 = 2;
const REQ_GET_TOPLEVEL: u16 = 1;
const REQ_SET_TITLE: u16 = 2;
const REQ_MOVE: u16 = 5;
const REQ_SET_INPUT_REGION: u16 = 5;
const WL_POINTER_RELEASE: u16 = 1;
const REQ_DESTROY: u16 = 0;
const REQ_REGION_DESTROY: u16 = 0;
const REQ_REGION_ADD: u16 = 1;

// U+200B (Zero Width Space) and U+200C (Zero Width Non-Joiner)
const CUSTOM_ID_PREFIX: &str = "\u{200B}\u{200C}";

// ── Wire helpers ──────────────────────────────────────────────────────────

#[inline]
fn parse_header(buf: &[u8]) -> Option<(u32, u16, usize)> {
    if buf.len() < 8 {
        return None;
    }
    let oid = u32::from_ne_bytes(buf[0..4].try_into().unwrap());
    let word = u32::from_ne_bytes(buf[4..8].try_into().unwrap());
    let op = (word & 0xFFFF) as u16;
    let sz = (word >> 16) as usize;
    if sz < 8 || !sz.is_multiple_of(4) {
        return None;
    }
    Some((oid, op, sz))
}

#[inline]
fn ru32(buf: &[u8], offset: usize) -> Option<u32> {
    buf.get(offset..offset + 4)
        .and_then(|b| b.try_into().ok())
        .map(u32::from_ne_bytes)
}

#[inline]
fn rfixed_i32(buf: &[u8], offset: usize) -> Option<i32> {
    buf.get(offset..offset + 4)
        .and_then(|b| b.try_into().ok())
        .map(i32::from_ne_bytes)
        .map(|value| value >> 8)
}

fn parse_wl_str(buf: &[u8], offset: usize) -> Option<(&str, usize)> {
    if offset + 4 > buf.len() {
        return None;
    }
    let raw_len = ru32(buf, offset)? as usize;
    if raw_len == 0 {
        return Some(("", offset + 4));
    }
    let data_start = offset + 4;
    let data_end = data_start + raw_len;
    if data_end > buf.len() {
        return None;
    }
    let nul = buf[data_start..data_end]
        .iter()
        .position(|&b| b == 0)
        .unwrap_or(raw_len);
    let s = std::str::from_utf8(&buf[data_start..data_start + nul]).ok()?;
    let padded = (raw_len + 3) & !3;
    let next = data_start + padded;
    if next > buf.len() {
        return None;
    }
    Some((s, next))
}

// ── Stream reassembly ─────────────────────────────────────────────────────

pub(crate) fn feed_inbound(
    fd: RawFd,
    chunk: &[u8],
    cmsg: Option<(&[u8], Vec<RawFd>)>,
) -> (Vec<u8>, Vec<u8>, Vec<RawFd>) {
    feed(fd, chunk, &RX_BUFS, &RX_PENDING_CTRL, true, cmsg)
}

pub(crate) fn feed_outbound(
    fd: RawFd,
    chunk: &[u8],
    cmsg: Option<(&[u8], Vec<RawFd>)>,
) -> (Vec<u8>, Vec<u8>, Vec<RawFd>) {
    feed(fd, chunk, &TX_BUFS, &TX_PENDING_CTRL, false, cmsg)
}

fn feed(
    fd: RawFd,
    chunk: &[u8],
    storage: &OnceLock<Mutex<HashMap<RawFd, Vec<u8>>>>,
    ctrl_storage: &OnceLock<Mutex<HashMap<RawFd, PendingControl>>>,
    is_event: bool,
    cmsg: Option<(&[u8], Vec<RawFd>)>,
) -> (Vec<u8>, Vec<u8>, Vec<RawFd>) {
    let (new_ctrl_bytes, new_ctrl_fds) = match cmsg {
        Some((bytes, fds)) => (bytes.to_vec(), fds),
        None => (Vec::new(), Vec::new()),
    };

    let Some(storage) = storage.get() else {
        return (chunk.to_vec(), new_ctrl_bytes, new_ctrl_fds);
    };

    let (msgs, sync_lost, mut pending_ctrl) = {
        let Ok(mut map) = storage.lock() else {
            return (chunk.to_vec(), new_ctrl_bytes, new_ctrl_fds);
        };
        let buf = map.entry(fd).or_default();
        buf.extend_from_slice(chunk);
        let mut msgs = Vec::new();
        let mut off = 0;
        while let Some((oid, op, sz)) = parse_header(&buf[off..]) {
            let Some(end) = off.checked_add(sz) else {
                break;
            };
            if end > buf.len() {
                break;
            }
            msgs.push((oid, op, buf[off..end].to_vec()));
            off = end;
        }
        buf.drain(..off);
        let sync_lost = buf.len() > 4 << 20;
        if sync_lost {
            buf.clear();
        }

        let mut pending_ctrl = PendingControl::default();
        if let Some(m) = ctrl_storage.get()
            && let Ok(mut ctrl_map) = m.lock()
            && let Some(stored) = ctrl_map.remove(&fd)
        {
            pending_ctrl = stored;
        }

        (msgs, sync_lost, pending_ctrl)
    };

    let had_complete_msgs = !msgs.is_empty();
    let mut out = Vec::new();
    for (oid, op, msg) in msgs {
        if is_event {
            let suppress = should_suppress_inbound(fd, oid, op, &msg);
            on_event(fd, oid, op, &msg);
            if suppress {
                continue;
            }
        } else {
            let suppress = on_request(fd, oid, op, &msg);
            if suppress {
                continue;
            }
        }
        out.extend_from_slice(&msg);
    }

    pending_ctrl.bytes.extend_from_slice(&new_ctrl_bytes);
    pending_ctrl.fds.extend(new_ctrl_fds);

    if sync_lost {
        clear_first_cursor_enter_watchers_for_fd(fd);
        if let Some(m) = CONNS.get()
            && let Ok(mut map) = m.lock()
            && let Some(conn) = map.get_mut(&fd)
        {
            conn.reset_tracking();
        }
        let PendingControl { bytes: _, fds } = pending_ctrl;
        return (Vec::new(), Vec::new(), fds);
    }

    if !had_complete_msgs {
        if pending_ctrl.bytes.is_empty() && pending_ctrl.fds.is_empty() {
            return (Vec::new(), Vec::new(), Vec::new());
        }

        if let Some(m) = ctrl_storage.get()
            && let Ok(mut ctrl_map) = m.lock()
        {
            ctrl_map.insert(fd, pending_ctrl);
            return (Vec::new(), Vec::new(), Vec::new());
        }

        let PendingControl { bytes, fds } = pending_ctrl;
        return (chunk.to_vec(), bytes, fds);
    }

    if out.is_empty() {
        let PendingControl { bytes: _, fds } = pending_ctrl;
        return (Vec::new(), Vec::new(), fds);
    }

    let PendingControl { bytes, fds } = pending_ctrl;
    (out, bytes, fds)
}

fn should_suppress_inbound(fd: RawFd, oid: u32, op: u16, msg: &[u8]) -> bool {
    if oid == 1
        && op == EVT_DELETE_ID
        && let Some(dead) = ru32(msg, 8)
    {
        let Some(conns) = CONNS.get() else {
            return false;
        };
        let Ok(mut guard) = conns.lock() else {
            return false;
        };
        let Some(conn) = guard.get_mut(&fd) else {
            return false;
        };

        // If it's one of our injected IDs, we're done with it.
        // Push it back into the stolen pool so we can reuse it later!
        if conn.injected_ids.remove(&dead) {
            conn.stolen_ids.push(dead);
            return true; // suppress from client
        }

        // Otherwise, steal up to 32 deleted IDs from the client for our own use.
        if conn.stolen_ids.len() < 32 {
            conn.stolen_ids.push(dead);
            return true; // suppress from client
        }
    }
    false
}

// ── Event / Request Handlers ──────────────────────────────────────────────

fn on_event(fd: RawFd, oid: u32, op: u16, msg: &[u8]) {
    let Some(conns) = CONNS.get() else { return };
    let Ok(mut guard) = conns.lock() else { return };
    let Some(conn) = guard.get_mut(&fd) else {
        return;
    };

    if oid == 1 && op == EVT_DELETE_ID {
        if let Some(dead) = ru32(msg, 8) {
            conn.purge(dead);
        }
        return;
    }

    if conn.ifaces.get(&oid) == Some(&Iface::WlPointer) {
        let pointer_event = handle_pointer_event(conn, oid, op, msg);
        drop(guard);

        if let Some((seat_id, serial, surf_id)) = pointer_event.button_info
            && let Some(m) = LAST_BUTTON.get()
            && let Ok(mut opt) = m.lock()
        {
            *opt = Some((fd, seat_id, serial, surf_id));
        }
        if let Some((wl_surface_id, x, y)) = pointer_event.entered_surface {
            fire_first_cursor_enter_watchers(fd, wl_surface_id, x, y);
        }
    }
}

struct PointerEventOutcome {
    button_info: Option<(u32, u32, u32)>,
    entered_surface: Option<(u32, i32, i32)>,
}

fn handle_pointer_event(
    conn: &mut WaylandConn,
    ptr_id: u32,
    op: u16,
    msg: &[u8],
) -> PointerEventOutcome {
    match op {
        EVT_ENTER => {
            if let (Some(surf_id), Some(x), Some(y)) =
                (ru32(msg, 12), rfixed_i32(msg, 16), rfixed_i32(msg, 20))
            {
                conn.pointer_focus.insert(ptr_id, surf_id);
                return PointerEventOutcome {
                    button_info: None,
                    entered_surface: Some((surf_id, x, y)),
                };
            }
            PointerEventOutcome {
                button_info: None,
                entered_surface: None,
            }
        }
        EVT_LEAVE => {
            conn.pointer_focus.remove(&ptr_id);
            PointerEventOutcome {
                button_info: None,
                entered_surface: None,
            }
        }
        EVT_BUTTON => {
            let serial = ru32(msg, 8);
            let state = ru32(msg, 20);
            if let (Some(serial), Some(BTN_PRESSED)) = (serial, state) {
                let surf_id = conn.pointer_focus.get(&ptr_id).copied();
                let seat_id = conn.pointer_seat.get(&ptr_id).copied();
                if let (Some(surf_id), Some(seat_id)) = (surf_id, seat_id) {
                    return PointerEventOutcome {
                        button_info: Some((seat_id, serial, surf_id)),
                        entered_surface: None,
                    };
                }
            }
            PointerEventOutcome {
                button_info: None,
                entered_surface: None,
            }
        }
        _ => PointerEventOutcome {
            button_info: None,
            entered_surface: None,
        },
    }
}

// Returns true if the message should be suppressed
fn on_request(fd: RawFd, oid: u32, op: u16, msg: &[u8]) -> bool {
    let mut suppress = false;
    let mut arm_watchers_for: Option<u32> = None;

    {
        let Some(conns) = CONNS.get() else {
            return false;
        };
        let Ok(mut guard) = conns.lock() else {
            return false;
        };
        let Some(conn) = guard.get_mut(&fd) else {
            return false;
        };
        let Some(iface) = conn.ifaces.get(&oid).copied() else {
            return false;
        };

        match (iface, op) {
            (Iface::WlDisplay, REQ_GET_REGISTRY) => {
                if let Some(new_id) = ru32(msg, 8) {
                    conn.ifaces.insert(new_id, Iface::WlRegistry);
                }
            }
            (Iface::WlRegistry, REQ_BIND) => {
                if let Some((iface_name, after)) = parse_wl_str(msg, 12)
                    && let Some(new_id) = ru32(msg, after + 4)
                {
                    let tag = match iface_name {
                        "wl_compositor" => {
                            conn.compositor_id = Some(new_id);
                            Some(Iface::WlCompositor)
                        }
                        "wl_seat" => Some(Iface::WlSeat),
                        "xdg_wm_base" => Some(Iface::XdgWmBase),
                        _ => None,
                    };
                    if let Some(tag) = tag {
                        conn.ifaces.insert(new_id, tag);
                    }
                }
            }
            (Iface::WlCompositor, REQ_CREATE_SURFACE) => {
                if let Some(new_id) = ru32(msg, 8) {
                    conn.ifaces.insert(new_id, Iface::WlSurface);
                }
            }
            (Iface::WlSeat, REQ_GET_POINTER) => {
                if let Some(new_id) = ru32(msg, 8) {
                    conn.ifaces.insert(new_id, Iface::WlPointer);
                    conn.pointer_seat.insert(new_id, oid);
                }
            }
            (Iface::XdgWmBase, REQ_GET_XDG_SURFACE) => {
                if let (Some(xdg_id), Some(wl_id)) = (ru32(msg, 8), ru32(msg, 12)) {
                    conn.ifaces.insert(xdg_id, Iface::XdgSurface);
                    conn.xdg_to_wl.insert(xdg_id, wl_id);
                }
            }
            (Iface::XdgSurface, REQ_GET_TOPLEVEL) => {
                if let Some(top_id) = ru32(msg, 8) {
                    conn.ifaces.insert(top_id, Iface::XdgToplevel);
                    conn.top_to_xdg.insert(top_id, oid);
                    if let Some(wl_id) = conn.xdg_to_wl.get(&oid).copied() {
                        conn.wl_to_top.insert(wl_id, top_id);
                        arm_watchers_for = Some(wl_id);
                    }
                }
            }
            (Iface::XdgToplevel, REQ_SET_TITLE) => {
                // Intercept custom IDs injected into set_title requests
                if let Some((title, _)) = parse_wl_str(msg, 8)
                    && let Some(custom_id) = title.strip_prefix(CUSTOM_ID_PREFIX)
                {
                    let xdg_id = conn.top_to_xdg.get(&oid).copied();
                    let wl_surf = xdg_id.and_then(|xid| conn.xdg_to_wl.get(&xid).copied());

                    if let Some(wl_surf) = wl_surf
                        && let Some(m) = CUSTOM_ID_MAP.get()
                        && let Ok(mut map) = m.lock()
                    {
                        map.insert(custom_id.to_string(), (fd, wl_surf));
                    }
                    suppress = true;
                }
            }
            (Iface::WlSurface | Iface::XdgSurface | Iface::XdgToplevel, REQ_DESTROY) => {
                if let Some(wl_surface_id) = conn.wl_surface_for_window_object(oid, iface)
                    && let Some(m) = CUSTOM_ID_MAP.get()
                    && let Ok(mut map) = m.lock()
                {
                    map.retain(|_, v| !(v.0 == fd && v.1 == wl_surface_id));
                }
                conn.purge(oid);
            }
            (Iface::WlPointer, WL_POINTER_RELEASE) => {
                conn.purge(oid);
            }
            _ => {}
        }
    }

    if let Some(wl_surface_id) = arm_watchers_for {
        arm_first_cursor_enter_watchers(fd, wl_surface_id);
    }

    suppress
}

// ── Callbacks / Utilities ──────────────────────────────────────────────────

fn arm_first_cursor_enter_watchers(fd: RawFd, wl_surface_id: u32) {
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

fn fire_first_cursor_enter_watchers(fd: RawFd, wl_surface_id: u32, x: i32, y: i32) {
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

fn clear_first_cursor_enter_watchers_for_fd(fd: RawFd) {
    if let Some(watchers) = CURSOR_ENTER_WATCHERS.get()
        && let Ok(mut watchers) = watchers.lock()
    {
        watchers.retain(|(watch_fd, _), _| *watch_fd != fd);
    }
}

// ── Public APIs ────────────────────────────────────────────────────────────

pub(crate) fn is_wayland_socket(addr: *const c_void, addrlen: u32) -> bool {
    if addr.is_null() || (addrlen as usize) < mem::size_of::<sa_family_t>() {
        return false;
    }
    let sa = unsafe { &*(addr as *const sockaddr) };
    if sa.sa_family as i32 != AF_UNIX {
        return false;
    }

    let sun = unsafe { &*(addr as *const sockaddr_un) };
    let path_offset = mem::size_of::<sa_family_t>();
    let path_len = (addrlen as usize)
        .saturating_sub(path_offset)
        .min(sun.sun_path.len());
    if path_len == 0 {
        return false;
    }

    let raw = unsafe { std::slice::from_raw_parts(sun.sun_path.as_ptr() as *const u8, path_len) };
    let candidate = if raw[0] == 0 {
        &raw[1..]
    } else {
        let end = raw.iter().position(|&b| b == 0).unwrap_or(raw.len());
        &raw[..end]
    };

    if candidate.is_empty() {
        return false;
    }
    if let Ok(disp) = std::env::var("WAYLAND_DISPLAY") {
        return candidate.ends_with(disp.as_bytes());
    }

    let filename = candidate
        .iter()
        .rposition(|&b| b == b'/')
        .map(|p| &candidate[p + 1..])
        .unwrap_or(candidate);
    filename.starts_with(b"wayland-")
        && filename.len() > 8
        && filename[8..].iter().all(|b| b.is_ascii_digit())
}

pub(crate) fn on_new_connection(fd: RawFd) {
    IS_WAYLAND.set(true).ok();
    if let Some(m) = CONNS.get()
        && let Ok(mut map) = m.lock()
    {
        map.entry(fd).or_insert_with(WaylandConn::new);
    }
}

pub(crate) fn on_close(fd: RawFd) {
    if let Some(m) = CONNS.get()
        && let Ok(mut map) = m.lock()
    {
        map.remove(&fd);
    }
    if let Some(m) = LAST_BUTTON.get()
        && let Ok(mut opt) = m.lock()
        && opt.is_some_and(|(f, _, _, _)| f == fd)
    {
        *opt = None;
    }
    if let Some(m) = RX_BUFS.get() {
        let _ = m.lock().map(|mut g| g.remove(&fd));
    }
    if let Some(m) = TX_BUFS.get() {
        let _ = m.lock().map(|mut g| g.remove(&fd));
    }
    if let Some(m) = RX_PENDING_CTRL.get() {
        if let Ok(mut g) = m.lock()
            && let Some(pending) = g.remove(&fd)
        {
            close_pending_control(pending);
        }
    }
    if let Some(m) = TX_PENDING_CTRL.get() {
        if let Ok(mut g) = m.lock()
            && let Some(pending) = g.remove(&fd)
        {
            close_pending_control(pending);
        }
    }
    if let Some(m) = CUSTOM_ID_MAP.get()
        && let Ok(mut map) = m.lock()
    {
        map.retain(|_, v| v.0 != fd);
    }
    clear_first_cursor_enter_watchers_for_fd(fd);
}

pub(super) fn is_wayland() -> bool {
    *IS_WAYLAND.get().unwrap_or(&false)
}

pub(super) fn on_next_new_window_first_cursor_enter(
    cb: impl FnOnce(i32, i32) + Send + 'static,
) -> bool {
    let Some(m) = NEXT_TOPLEVEL_CURSOR_ENTER.get() else {
        return false;
    };
    let Ok(mut cbs) = m.lock() else {
        return false;
    };
    cbs.push(Box::new(cb));
    true
}

pub(super) fn send_xdg_toplevel_move() -> bool {
    let Some((fd, seat_id, serial, wl_surf_id)) = LAST_BUTTON
        .get()
        .and_then(|m| m.lock().ok())
        .and_then(|g| *g)
    else {
        return false;
    };

    let top_id = {
        let Some(conns) = CONNS.get() else {
            return false;
        };
        let Ok(guard) = conns.lock() else {
            return false;
        };
        let Some(conn) = guard.get(&fd) else {
            return false;
        };

        conn.wl_to_top
            .get(&wl_surf_id)
            .copied()
            .filter(|id| conn.ifaces.get(id) == Some(&Iface::XdgToplevel))
            .or_else(|| {
                let xdg_id = conn
                    .xdg_to_wl
                    .iter()
                    .find(|(_, v)| **v == wl_surf_id)
                    .map(|(k, _)| *k);
                xdg_id.and_then(|xid| {
                    conn.top_to_xdg
                        .iter()
                        .filter(|(tid, sid)| {
                            **sid == xid && conn.ifaces.get(tid) == Some(&Iface::XdgToplevel)
                        })
                        .map(|(tid, _)| *tid)
                        .max()
                })
            })
    };

    let Some(top_id) = top_id else {
        return false;
    };

    let hdr_word = (REQ_MOVE as u32) | (16u32 << 16);
    let mut buf = [0u8; 16];
    buf[0..4].copy_from_slice(&top_id.to_ne_bytes());
    buf[4..8].copy_from_slice(&hdr_word.to_ne_bytes());
    buf[8..12].copy_from_slice(&seat_id.to_ne_bytes());
    buf[12..16].copy_from_slice(&serial.to_ne_bytes());

    super::hook::send_raw_msg(fd, &buf)
}

// ── Input region APIs ──────────────────────────────────────────────────────

fn window_id_to_fd_and_surface(window_id: &str) -> Option<(RawFd, u32)> {
    if let Some(m) = CUSTOM_ID_MAP.get()
        && let Ok(map) = m.lock()
        && let Some(&val) = map.get(window_id)
    {
        return Some(val);
    }
    None
}

fn create_region(fd: RawFd) -> Option<u32> {
    let (compositor_id, region_id) = {
        let conns = CONNS.get()?;
        let Ok(mut guard) = conns.lock() else {
            return None;
        };
        let conn = guard.get_mut(&fd)?;
        let compositor_id = conn.compositor_id?;
        let region_id = conn.alloc_injected_id()?;
        (compositor_id, region_id)
    };

    let hdr_word = (REQ_CREATE_REGION as u32) | (12u32 << 16);
    let mut buf = [0u8; 12];
    buf[0..4].copy_from_slice(&compositor_id.to_ne_bytes());
    buf[4..8].copy_from_slice(&hdr_word.to_ne_bytes());
    buf[8..12].copy_from_slice(&region_id.to_ne_bytes());

    if !super::hook::send_raw_msg(fd, &buf) {
        let conns = CONNS.get()?;
        let Ok(mut guard) = conns.lock() else {
            return None;
        };
        if let Some(conn) = guard.get_mut(&fd) {
            conn.injected_ids.remove(&region_id);
            // Return it to the pool if we failed to send
            conn.stolen_ids.push(region_id);
        }
        return None;
    }

    Some(region_id)
}

fn region_add(fd: RawFd, region_id: u32, x: i32, y: i32, w: i32, h: i32) -> bool {
    let hdr_word = (REQ_REGION_ADD as u32) | (24u32 << 16);
    let mut buf = [0u8; 24];
    buf[0..4].copy_from_slice(&region_id.to_ne_bytes());
    buf[4..8].copy_from_slice(&hdr_word.to_ne_bytes());
    buf[8..12].copy_from_slice(&x.to_ne_bytes());
    buf[12..16].copy_from_slice(&y.to_ne_bytes());
    buf[16..20].copy_from_slice(&w.to_ne_bytes());
    buf[20..24].copy_from_slice(&h.to_ne_bytes());

    super::hook::send_raw_msg(fd, &buf)
}

fn destroy_injected_region(fd: RawFd, region_id: u32) {
    let hdr_word = (REQ_REGION_DESTROY as u32) | (8u32 << 16);
    let mut buf = [0u8; 8];
    buf[0..4].copy_from_slice(&region_id.to_ne_bytes());
    buf[4..8].copy_from_slice(&hdr_word.to_ne_bytes());

    super::hook::send_raw_msg(fd, &buf);
}

pub(super) fn set_input_region_rects(window_id: &str, rects: Option<&[super::Rect]>) -> bool {
    let (fd, wl_surface_id) = match window_id_to_fd_and_surface(window_id) {
        Some(v) => v,
        None => return false,
    };

    let mut region_id = 0;

    if let Some(rects) = rects {
        if let Some(r_id) = create_region(fd) {
            region_id = r_id;
            for r in rects {
                if !region_add(fd, region_id, r.x, r.y, r.w, r.h) {
                    destroy_injected_region(fd, region_id);
                    return false;
                }
            }
        } else {
            return false;
        }
    }

    let hdr_word = (REQ_SET_INPUT_REGION as u32) | (12u32 << 16);
    let mut buf = [0u8; 12];
    buf[0..4].copy_from_slice(&wl_surface_id.to_ne_bytes());
    buf[4..8].copy_from_slice(&hdr_word.to_ne_bytes());
    buf[8..12].copy_from_slice(&region_id.to_ne_bytes()); // "0" acts safely as null identifier

    let res = super::hook::send_raw_msg(fd, &buf);

    if region_id != 0 {
        // Drop cache proxy directly. Re-allocation operates identically upon delete_id.
        destroy_injected_region(fd, region_id);
    }

    res
}

pub(crate) fn init_state() {
    CONNS.get_or_init(|| Mutex::new(HashMap::new()));
    LAST_BUTTON.get_or_init(|| Mutex::new(None));
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
