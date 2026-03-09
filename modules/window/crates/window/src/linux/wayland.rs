// Wayland man-in-the-middle hooker
//
// Strategy (stable-first, no libwayland symbol dependency):
//   • Hook connect(2)  — identify the Wayland Unix socket fd by its path.
//   • Hook close(2)    — detect when the tracked fd is closed so all
//                        per-connection state can be reset before the OS recycles
//                        the fd integer.  Without this, a reconnect that reuses
//                        the same fd number would silently corrupt the object map
//                        (root cause of the DevTools-open regression).
//   • Hook recvmsg(2)  — parse server→client events (wl_os_recvmsg_cloexec in
//                        wayland-os.c is the only inbound path used by libwayland).
//   • Hook sendmsg(2)  — parse client→server requests BEFORE they are sent so
//                        object state is consistent the moment the call returns
//                        (wl_connection_flush in connection.c is the only
//                        outbound path used by libwayland).
//
// Because libwayland exclusively uses sendmsg/recvmsg for all Wayland traffic
// (never plain send/recv), hooking those two covers 100 % of the protocol
// without touching any libwayland internal symbols.
//
// Wire format (from connection.c):
//   [object_id : u32][size<<16 | opcode : u32][payload ...]
//   All values are native-endian.  size includes the 8-byte header.

use std::{
    collections::HashMap,
    mem,
    os::fd::RawFd,
    sync::{Mutex, OnceLock},
};

use ilhook::x64::{CallbackOption, HookFlags, HookType, Hooker, Registers};
use libc::{
    AF_UNIX, RTLD_DEFAULT, c_int, c_void, msghdr,
    sa_family_t, sockaddr, sockaddr_un, ssize_t, dlsym,
};

// ── Global state ───────────────────────────────────────────────────────────

static IS_WAYLAND:    OnceLock<bool>                         = OnceLock::new();
static WAYLAND_FD:    OnceLock<Mutex<Option<RawFd>>>         = OnceLock::new();
static IFACES:        OnceLock<Mutex<HashMap<u32, Iface>>>   = OnceLock::new();
static POINTER_FOCUS: OnceLock<Mutex<HashMap<u32, u32>>>     = OnceLock::new(); // ptr_id → wl_surface_id
static POINTER_SEAT:  OnceLock<Mutex<HashMap<u32, u32>>>     = OnceLock::new(); // ptr_id → seat_id
static XDG_TO_WL:     OnceLock<Mutex<HashMap<u32, u32>>>     = OnceLock::new(); // xdg_surface_id → wl_surface_id
static WL_TO_TOP:     OnceLock<Mutex<HashMap<u32, u32>>>     = OnceLock::new(); // wl_surface_id → xdg_toplevel_id
static TOP_TO_XDG:    OnceLock<Mutex<HashMap<u32, u32>>>     = OnceLock::new(); // xdg_toplevel_id → xdg_surface_id
// Snapshot of the last button-press: (seat_id, serial, wl_surface_id)
// seat_id is captured at press time so pointer object lifecycle changes
// (e.g. DevTools opening/closing destroys and re-creates wl_pointer) cannot
// invalidate the recorded values before send_xdg_toplevel_move is called.
static LAST_BUTTON:   OnceLock<Mutex<Option<(u32, u32, u32)>>> = OnceLock::new();
// Per-fd reassembly buffers — messages can span multiple sendmsg/recvmsg calls.
static RX_BUFS: OnceLock<Mutex<HashMap<RawFd, Vec<u8>>>> = OnceLock::new();
static TX_BUFS: OnceLock<Mutex<HashMap<RawFd, Vec<u8>>>> = OnceLock::new();

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

// ── Wayland wire protocol opcodes ─────────────────────────────────────────
//
// Values from the Wayland core XML and xdg-shell XML.  Opcodes are per-object
// and start at 0.

// wl_display events (server → client)
const EVT_DELETE_ID:       u16 = 1; // wl_display::delete_id(id: uint)

// wl_display requests (client → server)
const REQ_GET_REGISTRY:    u16 = 1; // wl_display::get_registry(id: new_id)

// wl_registry requests
const REQ_BIND:            u16 = 0; // wl_registry::bind(name, iface_str, ver, new_id)

// wl_compositor requests
const REQ_CREATE_SURFACE:  u16 = 0; // wl_compositor::create_surface(id: new_id)

// wl_seat requests
const REQ_GET_POINTER:     u16 = 0; // wl_seat::get_pointer(id: new_id)

// wl_pointer events (server → client)
const EVT_ENTER:           u16 = 0; // wl_pointer::enter(serial, surface, sx_fixed, sy_fixed)
const EVT_LEAVE:           u16 = 1; // wl_pointer::leave(serial, surface)
const EVT_BUTTON:          u16 = 3; // wl_pointer::button(serial, time, button, state)
const BTN_PRESSED:         u32 = 1; // wl_pointer_button_state::pressed

// xdg_wm_base requests
const REQ_GET_XDG_SURFACE: u16 = 2; // xdg_wm_base::get_xdg_surface(id: new_id, surface: obj)

// xdg_surface requests
const REQ_GET_TOPLEVEL:    u16 = 1; // xdg_surface::get_toplevel(id: new_id)

// xdg_toplevel requests
const REQ_MOVE:            u16 = 5; // xdg_toplevel::move(seat: obj, serial: uint)

// wl_pointer::release (destructor, since version 3) is opcode 1.
// opcode 0 is wl_pointer::set_cursor — do NOT treat it as a destructor.
const WL_POINTER_RELEASE:  u16 = 1;

// Opcode 0 = destructor for: wl_surface, wl_pointer (release), xdg_surface, xdg_toplevel
const REQ_DESTROY:         u16 = 0;

// ── Wire helpers ──────────────────────────────────────────────────────────

/// Parses the 8-byte Wayland message header.
/// Returns `(object_id, opcode, total_message_size)` or `None` if malformed.
#[inline]
fn parse_header(buf: &[u8]) -> Option<(u32, u16, usize)> {
    if buf.len() < 8 { return None; }
    let oid  = u32::from_ne_bytes(buf[0..4].try_into().unwrap());
    let word = u32::from_ne_bytes(buf[4..8].try_into().unwrap());
    let op   = (word & 0xFFFF) as u16;
    let sz   = (word >> 16) as usize;
    if sz < 8 { return None; }
    Some((oid, op, sz))
}

/// Reads a u32 from `buf` at byte `offset`.
#[inline]
fn ru32(buf: &[u8], offset: usize) -> Option<u32> {
    buf.get(offset..offset + 4)
        .and_then(|b| b.try_into().ok())
        .map(u32::from_ne_bytes)
}

/// Reads a Wayland string argument (length-prefixed, NUL-terminated, 4-byte padded).
/// Returns `(str_slice, offset_of_next_arg)`.
///
/// Used to parse the interface name inside `wl_registry::bind`, which the Wayland
/// wire protocol encodes as (interface: string, version: uint, new_id: uint) because
/// the `new_id` argument has no static interface in the XML.
fn parse_wl_str(buf: &[u8], offset: usize) -> Option<(&str, usize)> {
    if offset + 4 > buf.len() { return None; }
    let raw_len = ru32(buf, offset)? as usize;
    if raw_len == 0 { return Some(("", offset + 4)); }
    let data_start = offset + 4;
    let data_end   = data_start + raw_len;
    if data_end > buf.len() { return None; }
    let nul = buf[data_start..data_end]
        .iter().position(|&b| b == 0).unwrap_or(raw_len);
    let s = std::str::from_utf8(&buf[data_start..data_start + nul]).ok()?;
    let padded = (raw_len + 3) & !3;
    let next = data_start + padded;
    if next > buf.len() { return None; }
    Some((s, next))
}

// ── State helpers ─────────────────────────────────────────────────────────

fn wayland_fd() -> Option<RawFd> {
    WAYLAND_FD.get()?.lock().ok().and_then(|g| *g)
}
fn is_wayland_fd(fd: RawFd) -> bool { wayland_fd() == Some(fd) }

fn iface_of(id: u32) -> Option<Iface> {
    IFACES.get()?.lock().ok()?.get(&id).copied()
}
fn set_iface(id: u32, iface: Iface) {
    if let Some(m) = IFACES.get() {
        if let Ok(mut map) = m.lock() { map.insert(id, iface); }
    }
}
fn del_iface(id: u32) {
    if let Some(m) = IFACES.get() {
        if let Ok(mut map) = m.lock() { map.remove(&id); }
    }
}

// ── Stream reassembly ─────────────────────────────────────────────────────
//
// libwayland's wl_connection_flush may call sendmsg multiple times before
// the buffer is fully drained, and wl_connection_read similarly calls recvmsg
// in a loop.  We reassemble the byte stream per-fd and dispatch complete
// messages only.

fn feed_inbound(fd: RawFd, chunk: &[u8]) {
    feed(fd, chunk, &RX_BUFS, true);
}
fn feed_outbound(fd: RawFd, chunk: &[u8]) {
    feed(fd, chunk, &TX_BUFS, false);
}

fn feed(
    fd: RawFd,
    chunk: &[u8],
    storage: &OnceLock<Mutex<HashMap<RawFd, Vec<u8>>>>,
    is_event: bool,
) {
    let Some(storage) = storage.get() else { return };

    // Hold the buffer lock only long enough to append + extract complete
    // messages.  Releasing before dispatch avoids nested lock ordering issues
    // (the handlers acquire IFACES, POINTER_FOCUS, etc.).
    let msgs: Vec<(u32, u16, Vec<u8>)> = {
        let Ok(mut map) = storage.lock() else { return };
        let buf = map.entry(fd).or_default();
        buf.extend_from_slice(chunk);
        let mut msgs = Vec::new();
        let mut off = 0;
        loop {
            let Some((oid, op, sz)) = parse_header(&buf[off..]) else { break };
            if off + sz > buf.len() { break }
            msgs.push((oid, op, buf[off..off + sz].to_vec()));
            off += sz;
        }
        buf.drain(..off);
        if buf.len() > 4 << 20 { buf.clear(); } // 4 MiB guard against sync loss
        msgs
    };

    for (oid, op, msg) in msgs {
        if is_event { on_event(oid, op, &msg); }
        else        { on_request(oid, op, &msg); }
    }
}

// ── Event handler (server → client) ───────────────────────────────────────

fn on_event(oid: u32, op: u16, msg: &[u8]) {
    // wl_display::delete_id — server confirms the client ID is fully released.
    if oid == 1 && op == EVT_DELETE_ID {
        if let Some(dead) = ru32(msg, 8) {
            // Only log objects we were actually tracking to avoid spam from
            // objects belonging to other Wayland connections on a reused fd.
            if let Some(iface) = iface_of(dead) {
                eprintln!("[wayland] delete_id({}) iface={:?}", dead, iface);
            }
            purge(dead);
        }
        return;
    }

    if iface_of(oid) == Some(Iface::WlPointer) {
        on_pointer_event(oid, op, msg);
    }
}

fn on_pointer_event(ptr_id: u32, op: u16, msg: &[u8]) {
    match op {
        EVT_ENTER => {
            // enter(serial: uint, surface: object, sx: fixed, sy: fixed) — 24 B
            if let Some(surf_id) = ru32(msg, 12) {
                if let Some(m) = POINTER_FOCUS.get() {
                    if let Ok(mut map) = m.lock() { map.insert(ptr_id, surf_id); }
                }
            }
        }
        EVT_LEAVE => {
            // A pointer can focus at most one surface at a time; just remove it.
            if let Some(m) = POINTER_FOCUS.get() {
                if let Ok(mut map) = m.lock() { map.remove(&ptr_id); }
            }
        }
        EVT_BUTTON => {
            // button(serial: uint, time: uint, button: uint, state: uint) — 24 B
            let serial = ru32(msg, 8);
            let state  = ru32(msg, 20);
            // Record only press events; the serial from a press is what
            // xdg_toplevel::move requires.
            if let (Some(serial), Some(BTN_PRESSED)) = (serial, state) {
                let surf_id = POINTER_FOCUS.get()
                    .and_then(|m| m.lock().ok())
                    .and_then(|map| map.get(&ptr_id).copied());
                // Snapshot seat_id now — if the pointer object is later destroyed
                // (e.g. DevTools opening causes a wl_pointer release + re-create)
                // the POINTER_SEAT entry for ptr_id will be purged, making a
                // deferred lookup return None.  Capturing it here keeps it valid.
                let seat_id = POINTER_SEAT.get()
                    .and_then(|m| m.lock().ok())
                    .and_then(|map| map.get(&ptr_id).copied());
                eprintln!(
                    "[wayland] EVT_BUTTON ptr={} serial={} surf={:?} seat={:?}",
                    ptr_id, serial, surf_id, seat_id
                );
                if let (Some(surf_id), Some(seat_id)) = (surf_id, seat_id) {
                    if let Some(m) = LAST_BUTTON.get() {
                        if let Ok(mut opt) = m.lock() {
                            *opt = Some((seat_id, serial, surf_id));
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

// ── Request handler (client → server) ─────────────────────────────────────

fn on_request(oid: u32, op: u16, msg: &[u8]) {
    let Some(iface) = iface_of(oid) else { return };

    match (iface, op) {
        // wl_display::get_registry(id: new_id)
        (Iface::WlDisplay, REQ_GET_REGISTRY) => {
            if let Some(new_id) = ru32(msg, 8) { set_iface(new_id, Iface::WlRegistry); }
        }

        // wl_registry::bind(name: uint, interface: string, version: uint, id: new_id)
        //
        // new_id has no static interface in the XML so the wire format prepends
        // (interface: string, version: uint) before the actual id uint.
        (Iface::WlRegistry, REQ_BIND) => {
            // bytes [8..12] = name (uint); bytes [12..] = interface string
            if let Some((iface_name, after)) = parse_wl_str(msg, 12) {
                // after+0 = version (u32), after+4 = new_id (u32)
                if let Some(new_id) = ru32(msg, after + 4) {
                    let iface = match iface_name {
                        "wl_compositor" => Some(Iface::WlCompositor),
                        "wl_seat"       => Some(Iface::WlSeat),
                        "xdg_wm_base"   => Some(Iface::XdgWmBase),
                        _               => None,
                    };
                    if let Some(iface) = iface { set_iface(new_id, iface); }
                }
            }
        }

        // wl_compositor::create_surface(id: new_id)
        (Iface::WlCompositor, REQ_CREATE_SURFACE) => {
            if let Some(new_id) = ru32(msg, 8) { set_iface(new_id, Iface::WlSurface); }
        }

        // wl_seat::get_pointer(id: new_id)
        // Record the seat association so send_xdg_toplevel_move can look it up.
        (Iface::WlSeat, REQ_GET_POINTER) => {
            if let Some(new_id) = ru32(msg, 8) {
                eprintln!("[wayland] new WlPointer id={} from seat={}", new_id, oid);
                set_iface(new_id, Iface::WlPointer);
                if let Some(m) = POINTER_SEAT.get() {
                    if let Ok(mut map) = m.lock() { map.insert(new_id, oid); }
                }
            }
        }

        // xdg_wm_base::get_xdg_surface(id: new_id, surface: object)
        (Iface::XdgWmBase, REQ_GET_XDG_SURFACE) => {
            if let (Some(xdg_id), Some(wl_id)) = (ru32(msg, 8), ru32(msg, 12)) {
                set_iface(xdg_id, Iface::XdgSurface);
                if let Some(m) = XDG_TO_WL.get() {
                    if let Ok(mut map) = m.lock() { map.insert(xdg_id, wl_id); }
                }
            }
        }

        // xdg_surface::get_toplevel(id: new_id)
        (Iface::XdgSurface, REQ_GET_TOPLEVEL) => {
            if let Some(top_id) = ru32(msg, 8) {
                set_iface(top_id, Iface::XdgToplevel);
                if let Some(m) = TOP_TO_XDG.get() {
                    if let Ok(mut map) = m.lock() { map.insert(top_id, oid); }
                }
                // Populate the direct wl_surface → xdg_toplevel lookup used by
                // send_xdg_toplevel_move; this avoids a reverse scan at drag time.
                let wl_id = XDG_TO_WL.get()
                    .and_then(|m| m.lock().ok())
                    .and_then(|map| map.get(&oid).copied());
                if let Some(wl_id) = wl_id {
                    if let Some(m) = WL_TO_TOP.get() {
                        if let Ok(mut map) = m.lock() { map.insert(wl_id, top_id); }
                    }
                }
            }
        }

        // Destructor requests — the client frees the ID immediately on send;
        // we must clean up without waiting for the server's delete_id event.
        // NOTE: wl_pointer's destructor is opcode 1 (release), NOT opcode 0
        //       (set_cursor).  Conflating them would purge the pointer on every
        //       cursor-shape change.
        (Iface::WlSurface | Iface::XdgSurface | Iface::XdgToplevel, REQ_DESTROY) => {
            purge(oid);
        }
        (Iface::WlPointer, WL_POINTER_RELEASE) => {
            purge(oid);
        }

        _ => {}
    }
}

// ── Object lifecycle cleanup ───────────────────────────────────────────────

fn purge(id: u32) {
    match iface_of(id) {
        Some(Iface::WlPointer) => {
            eprintln!("[wayland] purge WlPointer id={}", id);
            if let Some(m) = POINTER_FOCUS.get() { if let Ok(mut map) = m.lock() { map.remove(&id); } }
            if let Some(m) = POINTER_SEAT.get()  { if let Ok(mut map) = m.lock() { map.remove(&id); } }
        }
        Some(Iface::WlSurface) => {
            if let Some(m) = XDG_TO_WL.get()     { if let Ok(mut map) = m.lock() { map.retain(|_, &mut v| v != id); } }
            if let Some(m) = WL_TO_TOP.get()      { if let Ok(mut map) = m.lock() { map.remove(&id); } }
            if let Some(m) = POINTER_FOCUS.get()  { if let Ok(mut map) = m.lock() { map.retain(|_, &mut v| v != id); } }
        }
        Some(Iface::XdgSurface) => {
            // Cascade: purge any xdg_toplevel that depends on this xdg_surface.
            // Locks are dropped before the recursive call.
            let owned_top = TOP_TO_XDG.get()
                .and_then(|m| m.lock().ok())
                .and_then(|map| map.iter().find(|(_, v)| **v == id).map(|(k, _)| *k));
            if let Some(tid) = owned_top { purge(tid); }
            if let Some(m) = XDG_TO_WL.get() { if let Ok(mut map) = m.lock() { map.remove(&id); } }
        }
        Some(Iface::XdgToplevel) => {
            if let Some(m) = TOP_TO_XDG.get() { if let Ok(mut map) = m.lock() { map.remove(&id); } }
            if let Some(m) = WL_TO_TOP.get()  { if let Ok(mut map) = m.lock() { map.retain(|_, &mut v| v != id); } }
        }
        Some(Iface::WlSeat) => {
            if let Some(m) = POINTER_SEAT.get() { if let Ok(mut map) = m.lock() { map.retain(|_, &mut v| v != id); } }
        }
        _ => {}
    }
    del_iface(id);
}

// ── Wayland socket path detection ─────────────────────────────────────────
//
// Mirrors the logic in wl_os_socket_cloexec / wl_display_connect in
// wayland-client.c: the socket path is $XDG_RUNTIME_DIR/$WAYLAND_DISPLAY
// (or $XDG_RUNTIME_DIR/wayland-0 by default).

fn is_wayland_socket(addr: *const c_void, addrlen: u32) -> bool {
    if addr.is_null() || (addrlen as usize) < mem::size_of::<sa_family_t>() {
        return false;
    }
    let sa = unsafe { &*(addr as *const sockaddr) };
    if sa.sa_family as i32 != AF_UNIX { return false; }

    let sun = unsafe { &*(addr as *const sockaddr_un) };
    let path_offset = mem::size_of::<sa_family_t>();
    let path_len = (addrlen as usize)
        .saturating_sub(path_offset)
        .min(sun.sun_path.len());
    if path_len == 0 { return false; }

    let raw =
        unsafe { std::slice::from_raw_parts(sun.sun_path.as_ptr() as *const u8, path_len) };

    // Abstract Unix sockets begin with a NUL byte; filesystem sockets are C-strings.
    let candidate = if raw[0] == 0 {
        &raw[1..]
    } else {
        let end = raw.iter().position(|&b| b == 0).unwrap_or(raw.len());
        &raw[..end]
    };
    if candidate.is_empty() { return false; }

    // Fast path: path contains the literal string "wayland".
    if candidate.windows(7).any(|w| w == b"wayland") { return true; }

    // Slower path: compare the filename component against $WAYLAND_DISPLAY.
    if let Ok(disp) = std::env::var("WAYLAND_DISPLAY") {
        return candidate.ends_with(disp.as_bytes());
    }
    false
}

// ── Connection reset ──────────────────────────────────────────────────────
//
// Called when the tracked Wayland fd is closed.  Clears all per-connection
// state so that when Chromium reconnects (possibly reusing the same fd number)
// hook_connect properly re-initialises everything from a clean slate.
//
// IS_WAYLAND is intentionally left true — we know this process uses Wayland.

fn reset_connection_state(old_fd: RawFd) {
    eprintln!("[wayland] fd {} closed — resetting connection state", old_fd);
    if let Some(m) = WAYLAND_FD.get()    { let _ = m.lock().map(|mut g| *g = None); }
    if let Some(m) = IFACES.get() {
        let _ = m.lock().map(|mut g| {
            g.clear();
            g.insert(1, Iface::WlDisplay); // wl_display is always object ID 1
        });
    }
    if let Some(m) = POINTER_FOCUS.get() { let _ = m.lock().map(|mut g| g.clear()); }
    if let Some(m) = POINTER_SEAT.get()  { let _ = m.lock().map(|mut g| g.clear()); }
    if let Some(m) = XDG_TO_WL.get()    { let _ = m.lock().map(|mut g| g.clear()); }
    if let Some(m) = WL_TO_TOP.get()    { let _ = m.lock().map(|mut g| g.clear()); }
    if let Some(m) = TOP_TO_XDG.get()   { let _ = m.lock().map(|mut g| g.clear()); }
    // Clear LAST_BUTTON: the snapshotted wl_surface_id is invalid after
    // reconnection (new connection uses different object IDs).
    if let Some(m) = LAST_BUTTON.get()  { let _ = m.lock().map(|mut g| *g = None); }
    if let Some(m) = RX_BUFS.get()      { let _ = m.lock().map(|mut g| g.remove(&old_fd)); }
    if let Some(m) = TX_BUFS.get()      { let _ = m.lock().map(|mut g| g.remove(&old_fd)); }
}

// ── Hook callbacks ─────────────────────────────────────────────────────────

/// connect(2) — detect the Wayland socket fd.
/// Uses `if opt.is_none()` so multiple simultaneous Wayland connections
/// (e.g. GPU process) don't override the first one we tracked.  After a
/// reset_connection_state() call WAYLAND_FD is set back to None, so the
/// next connect to a Wayland socket is properly picked up as the new main fd.
unsafe extern "win64" fn hook_connect(reg: *mut Registers, orig: usize, _: usize) -> usize {
    let f: extern "C" fn(c_int, *const c_void, u32) -> c_int = unsafe { mem::transmute(orig) };
    let fd      = unsafe { (*reg).rdi as c_int };
    let addr    = unsafe { (*reg).rsi as *const c_void };
    let addrlen = unsafe { (*reg).rdx as u32 };

    let ret = f(fd, addr, addrlen);

    if ret == 0 && is_wayland_socket(addr, addrlen) {
        IS_WAYLAND.set(true).ok();
        if let Some(guard) = WAYLAND_FD.get() {
            if let Ok(mut opt) = guard.lock() {
                if opt.is_none() { *opt = Some(fd); }
            }
        }
    }

    ret as usize
}

/// close(2) — detect when the tracked Wayland fd is closed so we can reset
/// all per-connection state.  Without this, if the OS recycles the same fd
/// integer for a new Wayland connection, is_wayland_fd would return true for
/// the new connection while IFACES etc. still hold stale data from the old one.
unsafe extern "win64" fn hook_close(reg: *mut Registers, orig: usize, _: usize) -> usize {
    let f: extern "C" fn(c_int) -> c_int = unsafe { mem::transmute(orig) };
    let fd = unsafe { (*reg).rdi as c_int };
    if is_wayland_fd(fd) {
        reset_connection_state(fd);
    }
    f(fd) as usize
}

/// recvmsg(2) — intercept server→client Wayland events.
/// libwayland uses wl_os_recvmsg_cloexec (wayland-os.c) which calls recvmsg.
unsafe extern "win64" fn hook_recvmsg(reg: *mut Registers, orig: usize, _: usize) -> usize {
    let f: extern "C" fn(c_int, *mut msghdr, c_int) -> ssize_t = unsafe { mem::transmute(orig) };
    let fd    = unsafe { (*reg).rdi as c_int };
    let hdr   = unsafe { (*reg).rsi as *mut msghdr };
    let flags = unsafe { (*reg).rdx as c_int };

    let ret = f(fd, hdr, flags);

    if ret > 0 && is_wayland_fd(fd) && !hdr.is_null() {
        let h = unsafe { &*hdr };
        if !h.msg_iov.is_null() {
            let mut remaining = ret as usize;
            let mut packet = Vec::with_capacity(remaining);
            for i in 0..h.msg_iovlen {
                if remaining == 0 { break; }
                let iov = unsafe { &*h.msg_iov.add(i) };
                if iov.iov_base.is_null() || iov.iov_len == 0 { continue; }
                let take = iov.iov_len.min(remaining);
                packet.extend_from_slice(unsafe {
                    std::slice::from_raw_parts(iov.iov_base as *const u8, take)
                });
                remaining -= take;
            }
            feed_inbound(fd, &packet);
        }
    }

    ret as usize
}

/// sendmsg(2) — intercept client→server Wayland requests.
/// libwayland's wl_connection_flush (connection.c) is the sole outbound path.
/// We parse BEFORE the actual send so that object state is current the instant
/// the syscall returns.
unsafe extern "win64" fn hook_sendmsg(reg: *mut Registers, orig: usize, _: usize) -> usize {
    let f: extern "C" fn(c_int, *const msghdr, c_int) -> ssize_t = unsafe { mem::transmute(orig) };
    let fd    = unsafe { (*reg).rdi as c_int };
    let hdr   = unsafe { (*reg).rsi as *const msghdr };
    let flags = unsafe { (*reg).rdx as c_int };

    if is_wayland_fd(fd) && !hdr.is_null() {
        let h = unsafe { &*hdr };
        if !h.msg_iov.is_null() {
            let mut packet = Vec::new();
            for i in 0..h.msg_iovlen {
                let iov = unsafe { &*h.msg_iov.add(i) };
                if iov.iov_base.is_null() || iov.iov_len == 0 { continue; }
                packet.extend_from_slice(unsafe {
                    std::slice::from_raw_parts(iov.iov_base as *const u8, iov.iov_len)
                });
            }
            if !packet.is_empty() { feed_outbound(fd, &packet); }
        }
    }

    f(fd, hdr, flags) as usize
}

// ── Public API ─────────────────────────────────────────────────────────────

pub(super) fn is_wayland() -> bool {
    *IS_WAYLAND.get().unwrap_or(&false)
}

/// Sends `xdg_toplevel::move` using the serial from the last recorded
/// `wl_pointer::button` press.  Returns `true` on success.
pub(super) fn send_xdg_toplevel_move() -> bool {
    // Retrieve the button-press snapshot captured in on_pointer_event.
    // seat_id was snapshotted at press time, so pointer lifecycle changes
    // (DevTools open/close, pointer re-creation) cannot invalidate it.
    let Some((seat_id, serial, wl_surf_id)) = LAST_BUTTON.get()
        .and_then(|m| m.lock().ok())
        .and_then(|g| *g)
    else {
        eprintln!("[wayland] send_xdg_toplevel_move: no button event recorded yet");
        return false;
    };

    // Primary: direct wl_surface → xdg_toplevel mapping populated at get_toplevel time.
    let top_id = WL_TO_TOP.get()
        .and_then(|m| m.lock().ok())
        .and_then(|map| map.get(&wl_surf_id).copied())
        .filter(|&id| iface_of(id) == Some(Iface::XdgToplevel))
        // Fallback: reverse-search through xdg_surface when the direct entry is stale.
        .or_else(|| {
            let xdg_id = XDG_TO_WL.get()
                .and_then(|m| m.lock().ok())
                .and_then(|map| {
                    map.iter()
                        .find(|(_, v)| **v == wl_surf_id)
                        .map(|(k, _)| *k)
                });
            xdg_id.and_then(|xid| {
                TOP_TO_XDG.get()
                    .and_then(|m| m.lock().ok())
                    .and_then(|map| {
                        map.iter()
                            .filter(|(tid, sid)| {
                                **sid == xid && iface_of(**tid) == Some(Iface::XdgToplevel)
                            })
                            .map(|(tid, _)| *tid)
                            .max()
                    })
            })
        });

    let Some(top_id) = top_id else {
        eprintln!("[wayland] send_xdg_toplevel_move: no live xdg_toplevel for wl_surface {}", wl_surf_id);
        return false;
    };

    let Some(fd) = wayland_fd() else {
        eprintln!("[wayland] send_xdg_toplevel_move: Wayland fd not captured");
        return false;
    };

    // Craft xdg_toplevel::move(seat: object, serial: uint)
    //   [xdg_toplevel_id : u32][size<<16 | opcode : u32][seat_id : u32][serial : u32]
    //   Total: 16 bytes.
    let hdr_word = (REQ_MOVE as u32) | (16u32 << 16);
    let mut buf = [0u8; 16];
    buf[0..4].copy_from_slice(&top_id.to_ne_bytes());
    buf[4..8].copy_from_slice(&hdr_word.to_ne_bytes());
    buf[8..12].copy_from_slice(&seat_id.to_ne_bytes());
    buf[12..16].copy_from_slice(&serial.to_ne_bytes());

    // Use write(2) directly rather than going through sendmsg to avoid
    // re-entering our own hook.  xdg_toplevel::move carries no file descriptors
    // so plain write(2) on the Unix socket is sufficient and atomic (< PIPE_BUF).
    eprintln!(
        "[wayland] send_xdg_toplevel_move: sending move toplevel={} seat={} serial={} wl_surf={}",
        top_id, seat_id, serial, wl_surf_id
    );
    let ret = unsafe { libc::write(fd, buf.as_ptr() as *const c_void, 16) };
    if ret != 16 {
        eprintln!(
            "[wayland] send_xdg_toplevel_move: write returned {} (errno {})",
            ret,
            unsafe { *libc::__errno_location() }
        );
        return false;
    }

    true
}

pub(super) fn init_wayland_hook() {
    // Initialise all state maps before any hook fires.
    WAYLAND_FD.get_or_init(|| Mutex::new(None));
    IFACES.get_or_init(|| {
        let mut m = HashMap::new();
        m.insert(1u32, Iface::WlDisplay); // wl_display is always object ID 1
        Mutex::new(m)
    });
    POINTER_FOCUS.get_or_init(|| Mutex::new(HashMap::new()));
    POINTER_SEAT .get_or_init(|| Mutex::new(HashMap::new()));
    XDG_TO_WL   .get_or_init(|| Mutex::new(HashMap::new()));
    WL_TO_TOP   .get_or_init(|| Mutex::new(HashMap::new()));
    TOP_TO_XDG  .get_or_init(|| Mutex::new(HashMap::new()));
    LAST_BUTTON .get_or_init(|| Mutex::new(None));
    RX_BUFS     .get_or_init(|| Mutex::new(HashMap::new()));
    TX_BUFS     .get_or_init(|| Mutex::new(HashMap::new()));

    unsafe {
        let connect_addr = dlsym(RTLD_DEFAULT, c"connect".as_ptr());
        let close_addr   = dlsym(RTLD_DEFAULT, c"close".as_ptr());
        let recvmsg_addr = dlsym(RTLD_DEFAULT, c"recvmsg".as_ptr());
        let sendmsg_addr = dlsym(RTLD_DEFAULT, c"sendmsg".as_ptr());

        for (name, addr, cb) in [
            ("connect", connect_addr, hook_connect as unsafe extern "win64" fn(*mut Registers, usize, usize) -> usize),
            ("close",   close_addr,   hook_close   as unsafe extern "win64" fn(*mut Registers, usize, usize) -> usize),
            ("recvmsg", recvmsg_addr, hook_recvmsg as unsafe extern "win64" fn(*mut Registers, usize, usize) -> usize),
            ("sendmsg", sendmsg_addr, hook_sendmsg as unsafe extern "win64" fn(*mut Registers, usize, usize) -> usize),
        ] {
            if addr.is_null() {
                eprintln!("[wayland] symbol not found: {}", name);
                continue;
            }
            match Hooker::new(
                addr as usize,
                HookType::Retn(cb),
                CallbackOption::None,
                0,
                HookFlags::empty(),
            ).hook() {
                Ok(h)  => { let _ = Box::into_raw(Box::new(h)); }
                Err(e) => eprintln!("[wayland] failed to hook {}: {:?}", name, e),
            }
        }
    }
}
