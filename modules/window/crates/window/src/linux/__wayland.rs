use std::{
    ffi::{c_int, c_void},
    mem,
    os::fd::RawFd,
    sync::{Mutex, OnceLock},
    collections::HashMap,
};

use ilhook::x64::{CallbackOption, HookFlags, HookType, Hooker, Registers};
use libc::{AF_UNIX, RTLD_DEFAULT, sa_family_t, size_t, sockaddr, sockaddr_un, ssize_t, socklen_t};
use libc::dlsym;

static WAYLAND_MAIN_FD: OnceLock<Mutex<Option<RawFd>>> = OnceLock::new();
static IS_WAYLAND: OnceLock<bool> = OnceLock::new();
static WAYLAND_POINTER_FOCUS: OnceLock<Mutex<HashMap<u32, u32>>> = OnceLock::new();
static WAYLAND_POINTER_TO_SEAT: OnceLock<Mutex<HashMap<u32, u32>>> = OnceLock::new();
static WAYLAND_OBJECT_INTERFACES: OnceLock<Mutex<HashMap<u32, WaylandInterface>>> = OnceLock::new();
static XDG_SURFACE_TO_WL_SURFACE: OnceLock<Mutex<HashMap<u32, u32>>> = OnceLock::new();
static XDG_TOPLEVEL_TO_XDG_SURFACE: OnceLock<Mutex<HashMap<u32, u32>>> = OnceLock::new();
static WL_SURFACE_TO_XDG_TOPLEVEL: OnceLock<Mutex<HashMap<u32, u32>>> = OnceLock::new();
static LAST_BUTTON_EVENT: OnceLock<Mutex<Option<(u32, u32, u32)>>> = OnceLock::new(); // (pointer_id, serial, surface_id)
static WAYLAND_RX_STREAM: OnceLock<Mutex<HashMap<RawFd, Vec<u8>>>> = OnceLock::new();
static WAYLAND_TX_STREAM: OnceLock<Mutex<HashMap<RawFd, Vec<u8>>>> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WaylandInterface {
    WlDisplay,
    WlRegistry,
    WlCompositor,
    WlSeat,
    WlPointer,
    WlSurface,
    XdgWmBase,
    XdgSurface,
    XdgToplevel,
    Unknown,
}

#[repr(C)]
struct iovec {
    iov_base: *mut c_void,
    iov_len: size_t,
}

#[repr(C)]
struct msghdr {
    msg_name: *mut c_void,
    msg_namelen: socklen_t,
    msg_iov: *mut iovec,
    msg_iovlen: size_t,
    msg_control: *mut c_void,
    msg_controllen: size_t,
    msg_flags: c_int,
}

// Wayland wire protocol opcodes for wl_pointer events
const WL_POINTER_ENTER: u16 = 0;
const WL_POINTER_BUTTON: u16 = 3;

// Wayland wire protocol opcodes for wl_display events
const WL_DISPLAY_DELETE_ID: u16 = 1;

// Wayland wire protocol opcodes for wl_display requests
const WL_DISPLAY_GET_REGISTRY: u16 = 1;

// Wayland wire protocol opcodes for wl_registry requests
const WL_REGISTRY_BIND: u16 = 0;

// Wayland wire protocol opcodes for wl_seat requests
const WL_SEAT_GET_POINTER: u16 = 0;

// Wayland wire protocol opcodes for wl_compositor requests
const WL_COMPOSITOR_CREATE_SURFACE: u16 = 0;

// Wayland wire protocol opcodes for xdg_wm_base requests
const XDG_WM_BASE_GET_XDG_SURFACE: u16 = 2;

// Wayland wire protocol opcodes for xdg_surface requests
const XDG_SURFACE_DESTROY: u16 = 0;
const XDG_SURFACE_GET_TOPLEVEL: u16 = 1;

// Wayland wire protocol opcodes for xdg_toplevel requests
const XDG_TOPLEVEL_DESTROY: u16 = 0;
const XDG_TOPLEVEL_MOVE: u16 = 5;

// Destroy opcode is 0 for all core wl_ objects that have a destructor
const WL_DESTRUCTOR_OPCODE: u16 = 0;

fn parse_message_header(buffer: &[u8]) -> Option<(u32, u16, u16)> {
    if buffer.len() < 8 {
        return None;
    }

    let object_id = u32::from_ne_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]);
    let opcode_and_size = u32::from_ne_bytes([buffer[4], buffer[5], buffer[6], buffer[7]]);
    let opcode = (opcode_and_size & 0xFFFF) as u16;
    let size = ((opcode_and_size >> 16) & 0xFFFF) as u16;
    Some((object_id, opcode, size))
}

fn hook_send_recv_enabled() -> bool {
    std::env::var("OPEN_ORPHEUS_WAYLAND_HOOK_SEND_RECV")
        .map(|v| v == "1")
        .unwrap_or(false)
}

// Returns true only when fd is the first Wayland connection we detected.
// All object tracking is scoped to this connection so that other Wayland
// connections in the process (e.g. Chromium's GPU-process color-manager
// connection) cannot corrupt our object-ID map.
fn is_main_wayland_fd(fd: RawFd) -> bool {
    WAYLAND_MAIN_FD
        .get()
        .and_then(|m| m.lock().ok())
        .and_then(|opt| *opt)
        == Some(fd)
}

unsafe fn parse_wayland_stream_chunk(fd: RawFd, chunk: &[u8], is_event_stream: bool) {
    let stream_map = if is_event_stream {
        WAYLAND_RX_STREAM.get()
    } else {
        WAYLAND_TX_STREAM.get()
    };

    let Some(stream_map) = stream_map else {
        return;
    };

    let Ok(mut map) = stream_map.lock() else {
        return;
    };

    let stream = map.entry(fd).or_insert_with(Vec::new);
    stream.extend_from_slice(chunk);

    let mut offset = 0;
    while offset + 8 <= stream.len() {
        let Some((_, _, msg_size)) = parse_message_header(&stream[offset..]) else {
            break;
        };

        let msg_size = msg_size as usize;
        if msg_size < 8 {
            // Corrupted framing; reset parser state for this fd.
            stream.clear();
            return;
        }

        if offset + msg_size > stream.len() {
            break;
        }

        if is_event_stream {
            unsafe { parse_wayland_event(&stream[offset..offset + msg_size]) };
        } else {
            unsafe { parse_wayland_request(&stream[offset..offset + msg_size]) };
        }
        offset += msg_size;
    }

    if offset > 0 {
        stream.drain(..offset);
    }

    // Hard cap to avoid unbounded growth if framing goes out of sync.
    if stream.len() > (1024 * 1024) {
        stream.clear();
    }
}

fn looks_like_wayland_unix_addr(addr: *const c_void, addrlen: u32) -> bool {
    if addr.is_null() || addrlen < mem::size_of::<sa_family_t>() as u32 {
        return false;
    }

    let sa = unsafe { &*(addr as *const sockaddr) };
    if sa.sa_family != AF_UNIX as sa_family_t {
        return false;
    }

    let sun = unsafe { &*(addr as *const sockaddr_un) };
    let path_offset = mem::size_of::<sa_family_t>();
    let path_len = (addrlen as usize).saturating_sub(path_offset).min(sun.sun_path.len());
    if path_len == 0 {
        return false;
    }

    let raw_path: &[u8] = unsafe {
        std::slice::from_raw_parts(sun.sun_path.as_ptr() as *const u8, path_len)
    };

    // Abstract unix sockets start with '\0'. Filesystem paths do not.
    let candidate = if raw_path[0] == 0 {
        &raw_path[1..]
    } else {
        let end = raw_path
            .iter()
            .position(|b| *b == 0)
            .unwrap_or(raw_path.len());
        &raw_path[..end]
    };

    if candidate.is_empty() {
        return false;
    }

    if candidate.windows(7).any(|w| w == b"wayland") {
        return true;
    }

    if let Ok(display) = std::env::var("WAYLAND_DISPLAY") {
        return candidate == display.as_bytes();
    }

    false
}

fn parse_wayland_string_at(buffer: &[u8], offset: usize) -> Option<(&str, usize)> {
    if offset + 4 > buffer.len() {
        return None;
    }

    let raw_len = u32::from_ne_bytes([
        buffer[offset],
        buffer[offset + 1],
        buffer[offset + 2],
        buffer[offset + 3],
    ]) as usize;

    if raw_len == 0 {
        return Some(("", offset + 4));
    }

    let str_start = offset + 4;
    let str_end = str_start + raw_len;
    if str_end > buffer.len() {
        return None;
    }

    let bytes = &buffer[str_start..str_end];
    let nul_terminated_len = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
    let s = std::str::from_utf8(&bytes[..nul_terminated_len]).ok()?;

    let padded_len = (raw_len + 3) & !3;
    let next_offset = str_start + padded_len;
    if next_offset > buffer.len() {
        return None;
    }

    Some((s, next_offset))
}

fn interface_from_name(name: &str) -> WaylandInterface {
    match name {
        "wl_display" => WaylandInterface::WlDisplay,
        "wl_registry" => WaylandInterface::WlRegistry,
        "wl_compositor" => WaylandInterface::WlCompositor,
        "wl_seat" => WaylandInterface::WlSeat,
        "wl_pointer" => WaylandInterface::WlPointer,
        "wl_surface" => WaylandInterface::WlSurface,
        "xdg_wm_base" => WaylandInterface::XdgWmBase,
        "xdg_surface" => WaylandInterface::XdgSurface,
        "xdg_toplevel" => WaylandInterface::XdgToplevel,
        _ => WaylandInterface::Unknown,
    }
}

unsafe fn track_wayland_connection(fd: RawFd) {
    // Record first Wayland fd as the main connection for all object tracking.
    if let Some(main_fd) = WAYLAND_MAIN_FD.get() {
        if let Ok(mut fd_opt) = main_fd.lock() {
            if fd_opt.is_none() {
                *fd_opt = Some(fd);
                println!("Tracking Wayland connection on fd: {}", fd);
            }
        }
    }
}

unsafe fn set_object_interface(object_id: u32, iface: WaylandInterface) {
    if let Some(obj_map) = WAYLAND_OBJECT_INTERFACES.get() {
        if let Ok(mut map) = obj_map.lock() {
            map.insert(object_id, iface);
        }
    }
}

unsafe fn object_interface(object_id: u32) -> Option<WaylandInterface> {
    WAYLAND_OBJECT_INTERFACES
        .get()
        .and_then(|m| m.lock().ok())
        .and_then(|map| map.get(&object_id).copied())
}

unsafe fn remove_object_interface(object_id: u32) {
    if let Some(obj_map) = WAYLAND_OBJECT_INTERFACES.get() {
        if let Ok(mut map) = obj_map.lock() {
            map.remove(&object_id);
        }
    }
}

unsafe fn set_pointer_focus(pointer_id: u32, surface_id: u32) {
    if let Some(pointer_focus) = WAYLAND_POINTER_FOCUS.get() {
        if let Ok(mut map) = pointer_focus.lock() {
            map.insert(pointer_id, surface_id);
        }
    }
}

unsafe fn clear_pointer_focus(pointer_id: u32) {
    if let Some(pointer_focus) = WAYLAND_POINTER_FOCUS.get() {
        if let Ok(mut map) = pointer_focus.lock() {
            map.remove(&pointer_id);
        }
    }
}

unsafe fn pointer_focus_surface(pointer_id: u32) -> Option<u32> {
    WAYLAND_POINTER_FOCUS
        .get()
        .and_then(|m| m.lock().ok())
        .and_then(|map| map.get(&pointer_id).copied())
}

unsafe fn set_pointer_seat(pointer_id: u32, seat_id: u32) {
    if let Some(pointer_to_seat) = WAYLAND_POINTER_TO_SEAT.get() {
        if let Ok(mut map) = pointer_to_seat.lock() {
            map.insert(pointer_id, seat_id);
        }
    }
}

unsafe fn get_pointer_seat(pointer_id: u32) -> Option<u32> {
    WAYLAND_POINTER_TO_SEAT
        .get()
        .and_then(|m| m.lock().ok())
        .and_then(|map| map.get(&pointer_id).copied())
}

unsafe fn cleanup_object(object_id: u32) {
    let iface = unsafe { object_interface(object_id) };
    
    match iface {
        Some(WaylandInterface::WlPointer) => {
            // Clean up pointer tracking
            unsafe { clear_pointer_focus(object_id) };
            if let Some(pointer_to_seat) = WAYLAND_POINTER_TO_SEAT.get() {
                if let Ok(mut map) = pointer_to_seat.lock() {
                    map.remove(&object_id);
                }
            }
        }
        Some(WaylandInterface::WlSurface) => {
            // Remove surface from xdg_surface mappings (by value)
            if let Some(xdg_map) = XDG_SURFACE_TO_WL_SURFACE.get() {
                if let Ok(mut map) = xdg_map.lock() {
                    map.retain(|_, &mut wl_surf| wl_surf != object_id);
                }
            }
            // Remove direct surface -> toplevel mapping
            if let Some(m) = WL_SURFACE_TO_XDG_TOPLEVEL.get() {
                if let Ok(mut map) = m.lock() {
                    map.remove(&object_id);
                }
            }
            // Clear any pointers focusing on this surface
            if let Some(pointer_focus) = WAYLAND_POINTER_FOCUS.get() {
                if let Ok(mut map) = pointer_focus.lock() {
                    map.retain(|_, &mut focused_surf| focused_surf != object_id);
                }
            }
        }
        Some(WaylandInterface::XdgSurface) => {
            // Find and clean up the xdg_toplevel that belongs to this xdg_surface first.
            let toplevel_id = XDG_TOPLEVEL_TO_XDG_SURFACE
                .get()
                .and_then(|m| m.lock().ok())
                .and_then(|map| {
                    map.iter()
                        .find(|(_, xdg_surf)| **xdg_surf == object_id)
                        .map(|(top_id, _)| *top_id)
                });
            if let Some(toplevel_id) = toplevel_id {
                // Remove from toplevel map
                if let Some(m) = XDG_TOPLEVEL_TO_XDG_SURFACE.get() {
                    if let Ok(mut map) = m.lock() { map.remove(&toplevel_id); }
                }
                // Remove from direct wl_surface -> xdg_toplevel map (by value)
                if let Some(m) = WL_SURFACE_TO_XDG_TOPLEVEL.get() {
                    if let Ok(mut map) = m.lock() {
                        map.retain(|_, &mut top_id| top_id != toplevel_id);
                    }
                }
                unsafe { remove_object_interface(toplevel_id) };
            }
            // Remove the xdg_surface itself from xdg_surface -> wl_surface map
            if let Some(xdg_map) = XDG_SURFACE_TO_WL_SURFACE.get() {
                if let Ok(mut map) = xdg_map.lock() {
                    map.remove(&object_id);
                }
            }
        }
        Some(WaylandInterface::XdgToplevel) => {
            // Remove toplevel from xdg_toplevel -> xdg_surface map
            if let Some(toplevel_map) = XDG_TOPLEVEL_TO_XDG_SURFACE.get() {
                if let Ok(mut map) = toplevel_map.lock() {
                    map.remove(&object_id);
                }
            }
            // Remove from direct wl_surface -> xdg_toplevel map (by value)
            if let Some(m) = WL_SURFACE_TO_XDG_TOPLEVEL.get() {
                if let Ok(mut map) = m.lock() {
                    map.retain(|_, &mut top_id| top_id != object_id);
                }
            }
        }
        Some(WaylandInterface::WlSeat) => {
            // Remove all pointers belonging to this seat (by value)
            if let Some(pointer_to_seat) = WAYLAND_POINTER_TO_SEAT.get() {
                if let Ok(mut map) = pointer_to_seat.lock() {
                    map.retain(|_, &mut seat| seat != object_id);
                }
            }
        }
        _ => {}
    }
    
    // Always remove from interface map
    unsafe { remove_object_interface(object_id) };
}

unsafe fn parse_wayland_event(buffer: &[u8]) {
    let Some((object_id, opcode, _size)) = parse_message_header(buffer) else {
        return;
    };

    // Handle wl_display.delete_id - server confirms object deletion
    if object_id == 1 && opcode == WL_DISPLAY_DELETE_ID && buffer.len() >= 12 {
        let deleted_id = u32::from_ne_bytes([buffer[8], buffer[9], buffer[10], buffer[11]]);
        unsafe { cleanup_object(deleted_id) };
        return;
    }

    // Track wl_pointer events
    if unsafe { object_interface(object_id) } == Some(WaylandInterface::WlPointer) {
        match opcode {
            WL_POINTER_ENTER => {
                if buffer.len() >= 24 {
                    let surface = u32::from_ne_bytes([buffer[12], buffer[13], buffer[14], buffer[15]]);
                    unsafe { set_pointer_focus(object_id, surface) };
                }
            }
            WL_POINTER_BUTTON => {
                if buffer.len() >= 24 {
                    let serial = u32::from_ne_bytes([buffer[8], buffer[9], buffer[10], buffer[11]]);
                    // Capture (pointer_id, serial, surface_id) at click time so that
                    // send_xdg_toplevel_move doesn't depend on pointer focus being
                    // correct later (e.g. after a new window opens).
                    let surface_id = unsafe { pointer_focus_surface(object_id) };
                    if let Some(surface_id) = surface_id {
                        if let Some(last_button) = LAST_BUTTON_EVENT.get() {
                            if let Ok(mut opt) = last_button.lock() {
                                *opt = Some((object_id, serial, surface_id));
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

unsafe fn parse_wayland_request(buffer: &[u8]) {
    let Some((object_id, opcode, size)) = parse_message_header(buffer) else {
        return;
    };

    let iface = unsafe { object_interface(object_id) }.unwrap_or(WaylandInterface::Unknown);

    if iface == WaylandInterface::WlDisplay && opcode == WL_DISPLAY_GET_REGISTRY && size >= 12 && buffer.len() >= 12 {
        let registry_id = u32::from_ne_bytes([buffer[8], buffer[9], buffer[10], buffer[11]]);
        unsafe { set_object_interface(registry_id, WaylandInterface::WlRegistry) };
        return;
    }

    if iface == WaylandInterface::WlRegistry && opcode == WL_REGISTRY_BIND && size >= 24 {
        if let Some((iface_name, after_iface)) = parse_wayland_string_at(buffer, 12) {
            if after_iface + 8 <= buffer.len() {
                let new_id = u32::from_ne_bytes([
                    buffer[after_iface + 4],
                    buffer[after_iface + 5],
                    buffer[after_iface + 6],
                    buffer[after_iface + 7],
                ]);

                let new_iface = interface_from_name(iface_name);
                unsafe { set_object_interface(new_id, new_iface) };
            }
        }
        return;
    }

    if iface == WaylandInterface::WlSeat && opcode == WL_SEAT_GET_POINTER && size >= 12 && buffer.len() >= 12 {
        let pointer_id = u32::from_ne_bytes([buffer[8], buffer[9], buffer[10], buffer[11]]);
        unsafe {
            set_object_interface(pointer_id, WaylandInterface::WlPointer);
            set_pointer_seat(pointer_id, object_id);
        }
        return;
    }

    // Destroy requests for objects we track — clean up immediately.
    // The client relinquishes the ID as soon as it sends destroy; we must not wait
    // for the server's wl_display.delete_id because the ID can be reused before then.
    let is_destroy = match iface {
        WaylandInterface::WlSurface | WaylandInterface::WlPointer => opcode == WL_DESTRUCTOR_OPCODE,
        WaylandInterface::XdgSurface => opcode == XDG_SURFACE_DESTROY,
        WaylandInterface::XdgToplevel => opcode == XDG_TOPLEVEL_DESTROY,
        _ => false,
    };
    if is_destroy {
        unsafe { cleanup_object(object_id) };
        return;
    }

    // Track wl_compositor.create_surface — assign WlSurface so cleanup_object works.
    if iface == WaylandInterface::WlCompositor && opcode == WL_COMPOSITOR_CREATE_SURFACE && size >= 12 && buffer.len() >= 12 {
        let new_surface_id = u32::from_ne_bytes([buffer[8], buffer[9], buffer[10], buffer[11]]);
        unsafe { set_object_interface(new_surface_id, WaylandInterface::WlSurface) };
        return;
    }

    // Track xdg_wm_base.get_xdg_surface - creates xdg_surface for a wl_surface
    if iface == WaylandInterface::XdgWmBase && opcode == XDG_WM_BASE_GET_XDG_SURFACE && size >= 16 && buffer.len() >= 16 {
        let xdg_surface_id = u32::from_ne_bytes([buffer[8], buffer[9], buffer[10], buffer[11]]);
        let wl_surface_id = u32::from_ne_bytes([buffer[12], buffer[13], buffer[14], buffer[15]]);
        unsafe { set_object_interface(xdg_surface_id, WaylandInterface::XdgSurface) };
        
        if let Some(map) = XDG_SURFACE_TO_WL_SURFACE.get() {
            if let Ok(mut m) = map.lock() {
                m.insert(xdg_surface_id, wl_surface_id);
            }
        }
        return;
    }
    
    // Track xdg_surface.get_toplevel - creates xdg_toplevel for an xdg_surface
    if iface == WaylandInterface::XdgSurface && opcode == XDG_SURFACE_GET_TOPLEVEL && size >= 12 && buffer.len() >= 12 {
        let xdg_toplevel_id = u32::from_ne_bytes([buffer[8], buffer[9], buffer[10], buffer[11]]);
        unsafe { set_object_interface(xdg_toplevel_id, WaylandInterface::XdgToplevel) };

        if let Some(map) = XDG_TOPLEVEL_TO_XDG_SURFACE.get() {
            if let Ok(mut m) = map.lock() {
                m.insert(xdg_toplevel_id, object_id);
            }
        }

        // Keep a direct mapping for drag lookup by focused wl_surface.
        let wl_surface_id = XDG_SURFACE_TO_WL_SURFACE
            .get()
            .and_then(|m| m.lock().ok())
            .and_then(|m| m.get(&object_id).copied());
        if let Some(wl_surface_id) = wl_surface_id {
            if let Some(map) = WL_SURFACE_TO_XDG_TOPLEVEL.get() {
                if let Ok(mut m) = map.lock() {
                    m.insert(wl_surface_id, xdg_toplevel_id);
                }
            }
        }
        return;
    }
}

unsafe extern "win64" fn on_recv(reg: *mut Registers, ori_func_ptr: usize, _: usize) -> usize {
    let recv_fn: extern "C" fn(c_int, *mut c_void, size_t, c_int) -> ssize_t =
        unsafe { mem::transmute(ori_func_ptr) };
    
    let (fd, buf, len, flags) = unsafe {
        ((*reg).rdi as c_int,
         (*reg).rsi as *mut c_void,
         (*reg).rdx as size_t,
         (*reg).rcx as c_int)
    };

    let result = recv_fn(fd, buf, len, flags);

    if result > 0 && is_main_wayland_fd(fd) {
        let buffer = unsafe { std::slice::from_raw_parts(buf as *const u8, result as usize) };
        unsafe { parse_wayland_stream_chunk(fd, buffer, true) };
    }

    result as usize
}

unsafe extern "win64" fn on_recvmsg(reg: *mut Registers, ori_func_ptr: usize, _: usize) -> usize {
    let recvmsg_fn: extern "C" fn(c_int, *mut msghdr, c_int) -> ssize_t =
        unsafe { mem::transmute(ori_func_ptr) };
    
    let (fd, msg, flags) = unsafe {
        ((*reg).rdi as c_int,
         (*reg).rsi as *mut msghdr,
         (*reg).rdx as c_int)
    };

    let result = recvmsg_fn(fd, msg, flags);

    if result > 0 && is_main_wayland_fd(fd) {
        if msg.is_null() {
            return result as usize;
        }

        let msg_ref = unsafe { &*msg };
        if msg_ref.msg_iov.is_null() {
            return result as usize;
        }

        let mut remaining = result as usize;
        let mut packet = Vec::with_capacity(remaining);

        for i in 0..msg_ref.msg_iovlen {
            if remaining == 0 { break; }
            let iov = unsafe { &*msg_ref.msg_iov.add(i) };
            if iov.iov_base.is_null() || iov.iov_len == 0 { continue; }
            let readable = iov.iov_len.min(remaining);
            packet.extend_from_slice(unsafe {
                std::slice::from_raw_parts(iov.iov_base as *const u8, readable)
            });
            remaining -= readable;
        }

        unsafe { parse_wayland_stream_chunk(fd, &packet, true) };
    }

    result as usize
}

unsafe extern "win64" fn on_connect(reg: *mut Registers, ori_func_ptr: usize, _: usize) -> usize {
    let connect_fn: extern "C" fn(c_int, *const c_void, u32) -> c_int =
        unsafe { mem::transmute(ori_func_ptr) };
    
    let (fd, addr, addrlen) = unsafe {
        ((*reg).rdi as c_int,
         (*reg).rsi as *const c_void,
         (*reg).rdx as u32)
    };

    let result = connect_fn(fd, addr, addrlen);

    // Check if this might be a Wayland connection by looking at XDG_RUNTIME_DIR
    if result == 0 && looks_like_wayland_unix_addr(addr, addrlen) {
        println!("Detected Wayland connection on fd: {}", fd);
        IS_WAYLAND.set(true).ok();
        unsafe { track_wayland_connection(fd) };
    }

    result as usize
}

unsafe extern "win64" fn on_send(reg: *mut Registers, ori_func_ptr: usize, _: usize) -> usize {
    let send_fn: extern "C" fn(c_int, *const c_void, size_t, c_int) -> ssize_t =
        unsafe { mem::transmute(ori_func_ptr) };
    
    let (fd, buf, len, flags) = unsafe {
        ((*reg).rdi as c_int,
         (*reg).rsi as *const c_void,
         (*reg).rdx as size_t,
         (*reg).rcx as c_int)
    };

    // Parse outgoing requests BEFORE the syscall so our object map is updated
    // atomically with respect to any concurrent thread that may call
    // send_xdg_toplevel_move immediately after this send returns.
    if is_main_wayland_fd(fd) && !buf.is_null() && len >= 8 {
        let buffer = unsafe { std::slice::from_raw_parts(buf as *const u8, len) };
        unsafe { parse_wayland_stream_chunk(fd, buffer, false) };
    }

    send_fn(fd, buf, len, flags) as usize
}

unsafe extern "win64" fn on_sendmsg(reg: *mut Registers, ori_func_ptr: usize, _: usize) -> usize {
    let sendmsg_fn: extern "C" fn(c_int, *const msghdr, c_int) -> ssize_t =
        unsafe { mem::transmute(ori_func_ptr) };
    
    let (fd, msg, flags) = unsafe {
        ((*reg).rdi as c_int,
         (*reg).rsi as *const msghdr,
         (*reg).rdx as c_int)
    };

    // Parse outgoing requests BEFORE the syscall — same reason as on_send above.
    if is_main_wayland_fd(fd) && !msg.is_null() {
        let msg_ref = unsafe { &*msg };
        if !msg_ref.msg_iov.is_null() {
            let mut packet = Vec::new();
            for i in 0..msg_ref.msg_iovlen {
                let iov = unsafe { &*msg_ref.msg_iov.add(i) };
                if iov.iov_base.is_null() || iov.iov_len == 0 { continue; }
                packet.extend_from_slice(unsafe {
                    std::slice::from_raw_parts(iov.iov_base as *const u8, iov.iov_len)
                });
            }
            if !packet.is_empty() {
                unsafe { parse_wayland_stream_chunk(fd, &packet, false) };
            }
        }
    }

    sendmsg_fn(fd, msg, flags) as usize
}

pub(super) fn is_wayland() -> bool {
    *IS_WAYLAND.get().unwrap_or(&false)
}

pub(super) fn send_xdg_toplevel_move() -> bool {
    unsafe {
        // Get the last button event — surface was captured at click time.
        let Some((pointer_id, serial, surface_id)) = LAST_BUTTON_EVENT
            .get()
            .and_then(|m| m.lock().ok())
            .and_then(|opt| *opt)
        else {
            eprintln!("send_xdg_toplevel_move: No button event recorded");
            return false;
        };
        
        // seat_id comes from pointer -> seat mapping (stable over lifetime of the seat)
        let seat_id = get_pointer_seat(pointer_id);
        let Some(seat_id) = seat_id else {
            eprintln!("send_xdg_toplevel_move: No seat found for pointer {}", pointer_id);
            return false;
        };
        
        // Get the xdg_surface_id from wl_surface_id
        let xdg_surface_id = XDG_SURFACE_TO_WL_SURFACE
            .get()
            .and_then(|m| m.lock().ok())
            .and_then(|map| {
                map.iter()
                    .find(|(_, wl_surf_id)| **wl_surf_id == surface_id)
                    .map(|(&xdg_surf_id, _)| xdg_surf_id)
            });
        
        let Some(xdg_surf_id) = xdg_surface_id else {
            eprintln!("send_xdg_toplevel_move: No xdg_surface found for wl_surface {}", surface_id);
            return false;
        };
        
        // Prefer direct mapping by focused wl_surface.
        let mut toplevel_id = WL_SURFACE_TO_XDG_TOPLEVEL
            .get()
            .and_then(|m| m.lock().ok())
            .and_then(|map| map.get(&surface_id).copied());

        // Fallback to reverse lookup if direct mapping is missing.
        if toplevel_id.is_none() {
            toplevel_id = XDG_TOPLEVEL_TO_XDG_SURFACE
                .get()
                .and_then(|m| m.lock().ok())
                .and_then(|mut map| {
                    // Drop stale entries where an object ID has been reused for another interface.
                    map.retain(|top_id, _| object_interface(*top_id) == Some(WaylandInterface::XdgToplevel));
                    map.iter()
                        .filter_map(|(&top_id, &surf_id)| if surf_id == xdg_surf_id { Some(top_id) } else { None })
                        .max()
                });
        }

        let toplevel_id = if let Some(id) = toplevel_id {
            id
        } else {
            // Fallback: pick the newest live toplevel with a valid xdg_surface -> wl_surface chain.
            let fallback = XDG_TOPLEVEL_TO_XDG_SURFACE
                .get()
                .and_then(|m| m.lock().ok())
                .and_then(|map| {
                    map.iter()
                        .filter_map(|(&top_id, &surf_id)| {
                            if object_interface(top_id) != Some(WaylandInterface::XdgToplevel) {
                                return None;
                            }
                            let has_surface = XDG_SURFACE_TO_WL_SURFACE
                                .get()
                                .and_then(|m| m.lock().ok())
                                .and_then(|m| m.get(&surf_id).copied())
                                .is_some();
                            if has_surface {
                                Some(top_id)
                            } else {
                                None
                            }
                        })
                        .max()
                });

            let Some(id) = fallback else {
                eprintln!("send_xdg_toplevel_move: No xdg_toplevel found for xdg_surface {}", xdg_surf_id);
                return false;
            };
            eprintln!(
                "send_xdg_toplevel_move: Falling back to live xdg_toplevel {} for xdg_surface {}",
                id, xdg_surf_id
            );
            id
        };

        if object_interface(toplevel_id) != Some(WaylandInterface::XdgToplevel) {
            eprintln!(
                "send_xdg_toplevel_move: Object {} is not an xdg_toplevel anymore",
                toplevel_id
            );
            return false;
        }
        
        // Get the main Wayland FD
        let fd = WAYLAND_MAIN_FD
            .get()
            .and_then(|m| m.lock().ok())
            .and_then(|opt| *opt);
        
        let Some(fd) = fd else {
            eprintln!("send_xdg_toplevel_move: No Wayland FD available");
            return false;
        };
        
        // Craft the xdg_toplevel::move wire protocol message
        // Format: [object_id: u32][opcode_and_size: u32][seat_id: u32][serial: u32]
        let message_size = 16u32;
        let opcode = XDG_TOPLEVEL_MOVE as u32;
        let opcode_and_size = opcode | (message_size << 16);
        
        let mut buffer = [0u8; 16];
        buffer[0..4].copy_from_slice(&toplevel_id.to_ne_bytes());
        buffer[4..8].copy_from_slice(&opcode_and_size.to_ne_bytes());
        buffer[8..12].copy_from_slice(&seat_id.to_ne_bytes());
        buffer[12..16].copy_from_slice(&serial.to_ne_bytes());
        
        // Send the message
        let result = libc::send(
            fd,
            buffer.as_ptr() as *const c_void,
            buffer.len(),
            0
        );
        
        if result < 0 {
            eprintln!("send_xdg_toplevel_move: Failed to send message, errno: {}", *libc::__errno_location());
            return false;
        }
        
        println!("send_xdg_toplevel_move: Sent move request (pointer {}, surface {}, xdg_toplevel {}, seat {}, serial {})",
                 pointer_id, surface_id, toplevel_id, seat_id, serial);
        true
    }
}

pub(super) fn init_wayland_hook() {
    WAYLAND_MAIN_FD.get_or_init(|| Mutex::new(None));
    WAYLAND_POINTER_FOCUS.get_or_init(|| Mutex::new(HashMap::new()));
    WAYLAND_POINTER_TO_SEAT.get_or_init(|| Mutex::new(HashMap::new()));
    WAYLAND_OBJECT_INTERFACES.get_or_init(|| {
        let mut map = HashMap::new();
        map.insert(1, WaylandInterface::WlDisplay);
        Mutex::new(map)
    });
    XDG_SURFACE_TO_WL_SURFACE.get_or_init(|| Mutex::new(HashMap::new()));
    XDG_TOPLEVEL_TO_XDG_SURFACE.get_or_init(|| Mutex::new(HashMap::new()));
    WL_SURFACE_TO_XDG_TOPLEVEL.get_or_init(|| Mutex::new(HashMap::new()));
    LAST_BUTTON_EVENT.get_or_init(|| Mutex::new(None));
    WAYLAND_RX_STREAM.get_or_init(|| Mutex::new(HashMap::new()));
    WAYLAND_TX_STREAM.get_or_init(|| Mutex::new(HashMap::new()));

    unsafe {
        // Hook recv to intercept Wayland messages.
        // Disabled by default to reduce startup instability and false positives.
        if hook_send_recv_enabled() {
            let recv_addr = dlsym(RTLD_DEFAULT, c"recv".as_ptr());
            if recv_addr.is_null() {
                eprintln!("Failed to find symbol recv");
                return;
            }
            println!("Found recv at {:x}", recv_addr as usize);

            let hook = Hooker::new(
                recv_addr as usize,
                HookType::Retn(on_recv),
                CallbackOption::None,
                0,
                HookFlags::empty()
            );
            match hook.hook() {
                Ok(h) => {
                    let _ = Box::into_raw(Box::new(h));
                }
                Err(e) => {
                    eprintln!("Failed to hook recv: {:?}", e);
                }
            }
        } else {
            println!("Skipping recv hook (set OPEN_ORPHEUS_WAYLAND_HOOK_SEND_RECV=1 to enable)");
        }

        // Hook recvmsg to intercept Wayland messages (more commonly used than recv)
        let recvmsg_addr = dlsym(RTLD_DEFAULT, c"recvmsg".as_ptr());
        if recvmsg_addr.is_null() {
            eprintln!("Failed to find symbol recvmsg");
            return;
        }
        println!("Found recvmsg at {:x}", recvmsg_addr as usize);

        let hook = Hooker::new(
            recvmsg_addr as usize,
            HookType::Retn(on_recvmsg),
            CallbackOption::None,
            0,
            HookFlags::empty()
        );
        match hook.hook() {
            Ok(h) => {
                let _ = Box::into_raw(Box::new(h));
            }
            Err(e) => {
                eprintln!("Failed to hook recvmsg: {:?}", e);
            }
        }

        // Hook send to intercept outgoing Wayland requests.
        // Disabled by default to reduce startup instability and false positives.
        if hook_send_recv_enabled() {
            let send_addr = dlsym(RTLD_DEFAULT, c"send".as_ptr());
            if send_addr.is_null() {
                eprintln!("Failed to find symbol send");
            } else {
                println!("Found send at {:x}", send_addr as usize);

                let hook = Hooker::new(
                    send_addr as usize,
                    HookType::Retn(on_send),
                    CallbackOption::None,
                    0,
                    HookFlags::empty()
                );
                match hook.hook() {
                    Ok(h) => {
                        let _ = Box::into_raw(Box::new(h));
                    }
                    Err(e) => {
                        eprintln!("Failed to hook send: {:?}", e);
                    }
                }
            }
        } else {
            println!("Skipping send hook (set OPEN_ORPHEUS_WAYLAND_HOOK_SEND_RECV=1 to enable)");
        }

        // Hook sendmsg to intercept outgoing Wayland requests
        let sendmsg_addr = dlsym(RTLD_DEFAULT, c"sendmsg".as_ptr());
        if sendmsg_addr.is_null() {
            eprintln!("Failed to find symbol sendmsg");
        } else {
            println!("Found sendmsg at {:x}", sendmsg_addr as usize);

            let hook = Hooker::new(
                sendmsg_addr as usize,
                HookType::Retn(on_sendmsg),
                CallbackOption::None,
                0,
                HookFlags::empty()
            );
            match hook.hook() {
                Ok(h) => {
                    let _ = Box::into_raw(Box::new(h));
                }
                Err(e) => {
                    eprintln!("Failed to hook sendmsg: {:?}", e);
                }
            }
        }

        // Hook connect to detect Wayland socket connections
        let connect_addr = dlsym(RTLD_DEFAULT, c"connect".as_ptr());
        if connect_addr.is_null() {
            eprintln!("Failed to find symbol connect");
            return;
        }
        println!("Found connect at {:x}", connect_addr as usize);

        let hook = Hooker::new(
            connect_addr as usize,
            HookType::Retn(on_connect),
            CallbackOption::None,
            0,
            HookFlags::empty()
        );
        match hook.hook() {
            Ok(h) => {
                let _ = Box::into_raw(Box::new(h));
            }
            Err(e) => {
                eprintln!("Failed to hook connect: {:?}", e);
            }
        }
    }
}