//! Generic display-server MITM transport.
//!
//! This module owns the syscall hooking, socketpair proxying, and per-connection
//! dispatch. It knows nothing about Wayland or X11 — each protocol registers a
//! [`Protocol`] and receives raw byte chunks through [`ConnectionHandler`].

pub(crate) mod syscalls;

use std::{
    collections::HashMap,
    os::fd::RawFd,
    sync::{Arc, Mutex, OnceLock},
};

use libc::{AF_UNIX, RTLD_DEFAULT, c_int, c_void, dlsym, msghdr};
use sighook::{inline_hook_jump, unhook};

// ── Transport types ───────────────────────────────────────────────────────

/// Which direction a chunk is travelling.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Direction {
    /// client → server (application → compositor / X server)
    Outbound,
    /// server → client (compositor / X server → application)
    Inbound,
}

/// Ancillary control data extracted from a `recvmsg` boundary.
#[derive(Clone)]
pub(crate) struct Cmsg {
    pub(crate) bytes: Vec<u8>,
    pub(crate) fds: Vec<RawFd>,
}

/// The result of filtering one chunk: bytes to forward plus any ancillary data
/// to attach to the first forwarded `sendmsg`, and fds the filter decided to
/// drop (and therefore close).
pub(crate) struct Filtered {
    pub(crate) data: Vec<u8>,
    pub(crate) cmsg: Vec<u8>,
    pub(crate) fds_to_close: Vec<RawFd>,
}

/// Cheap cloneable handle to the two ends of a proxied connection.
///
/// - `real_fd`: the socket connected to the real server.
/// - `app_fd`: the application-facing end of the socketpair (`pair[0]`).
///
/// Writing to `app_fd` makes the bytes appear on the proxy side as outbound
/// (client→server) traffic, which re-enters the proxy loop and filters.
#[derive(Clone)]
pub(crate) struct Sink {
    pub(crate) real_fd: RawFd,
    pub(crate) app_fd: RawFd,
    pub(crate) write_lock: Option<Arc<Mutex<()>>>,
}

impl Sink {
    /// Direct server-bound write, bypassing the filters.
    ///
    /// The caller must hold [`Sink::write_lock`] (when present) to serialize
    /// against the transport's forwarded writes.
    pub(crate) fn send_to_server(&self, bytes: &[u8]) -> bool {
        syscalls::send_raw_msg(self.real_fd, bytes)
    }

    /// Inject a client-originated message by writing into the app side of the
    /// socketpair. It re-enters the proxy loop as outbound traffic and passes
    /// through the outbound filter (Wayland uses this path).
    pub(crate) fn send_as_client(&self, bytes: &[u8]) -> bool {
        syscalls::send_raw_msg(self.app_fd, bytes)
    }
}

/// A registered protocol endpoint (Wayland, X11, ...).
pub(crate) trait Protocol: Send + Sync {
    /// Whether this protocol owns a socket at `addr`.
    fn matches(&self, addr: *const c_void, addrlen: u32) -> bool;

    /// Create per-connection state once `connect()` is intercepted.
    fn spawn(&self, app_fd: RawFd, real_fd: RawFd) -> Box<dyn ConnectionHandler>;
}

/// Per-connection protocol state. The transport hands raw chunks + ancillary
/// data to it and forwards whatever it returns.
pub(crate) trait ConnectionHandler: Send {
    /// Filter one chunk. Returning `None` means the protocol stream is desynced
    /// and the connection should be torn down.
    fn filter(&mut self, dir: Direction, chunk: &[u8], cmsg: Option<Cmsg>) -> Option<Filtered>;

    /// Called when the application closes its fd.
    fn on_close(&mut self);

    /// Optional write lock used to serialize server-bound writes (X11 uses
    /// this to keep injected requests atomic with forwarded traffic).
    fn write_lock(&self) -> Option<Arc<Mutex<()>>> {
        None
    }
}

// ── Hook metadata ─────────────────────────────────────────────────────────

static HOOK_CONNECT_ADDR: OnceLock<u64> = OnceLock::new();
static HOOK_CLOSE_ADDR: OnceLock<u64> = OnceLock::new();

/// Registered protocols, populated at hook install time.
static PROTOCOLS: OnceLock<Vec<Box<dyn Protocol>>> = OnceLock::new();
/// Active connections keyed by the application fd.
static CONNECTIONS: OnceLock<Mutex<HashMap<RawFd, Box<dyn ConnectionHandler>>>> = OnceLock::new();
/// Per-connection [`Sink`]s, so public protocol APIs can inject messages.
static SINKS: OnceLock<Mutex<HashMap<RawFd, Sink>>> = OnceLock::new();
/// Serializes installation/removal so an old proxy thread cannot delete state
/// belonging to a newly-reused application fd.
static CONNECTION_LIFECYCLE: OnceLock<Mutex<()>> = OnceLock::new();

/// Look up the injection handle for an application fd.
pub(crate) fn sink_for(fd: RawFd) -> Option<Sink> {
    let m = SINKS.get()?;
    let map = m.lock().ok()?;
    map.get(&fd).cloned()
}

fn find_protocol(addr: *const c_void, addrlen: u32) -> Option<&'static dyn Protocol> {
    let protos = PROTOCOLS.get()?;
    protos
        .iter()
        .map(|p| &**p)
        .find(|p| p.matches(addr, addrlen))
}

// ── Message forwarding ────────────────────────────────────────────────────

/// Extract `SCM_RIGHTS` fds from a control buffer.
fn extract_fds(cmsg_ptr: *mut c_void, cmsg_len: usize) -> Vec<RawFd> {
    let mut fds = Vec::new();
    let msg_for_scan = msghdr {
        msg_name: std::ptr::null_mut(),
        msg_namelen: 0,
        msg_iov: std::ptr::null_mut(),
        msg_iovlen: 0,
        msg_control: cmsg_ptr,
        msg_controllen: cmsg_len,
        msg_flags: 0,
    };
    unsafe {
        let mut cmsg = libc::CMSG_FIRSTHDR(&msg_for_scan);
        while !cmsg.is_null() {
            if (*cmsg).cmsg_level == libc::SOL_SOCKET && (*cmsg).cmsg_type == libc::SCM_RIGHTS {
                let fd_ptr = libc::CMSG_DATA(cmsg) as *const c_int;
                let header_len = (fd_ptr as usize) - (cmsg as usize);
                if (*cmsg).cmsg_len as usize > header_len {
                    let data_len = (*cmsg).cmsg_len as usize - header_len;
                    let fd_count = data_len / std::mem::size_of::<c_int>();
                    for i in 0..fd_count {
                        fds.push(*fd_ptr.add(i));
                    }
                }
            }
            cmsg = libc::CMSG_NXTHDR(&msg_for_scan, cmsg);
        }
    }
    fds
}

fn forward_msg(from: RawFd, to: RawFd, dir: Direction, app_fd: RawFd) -> bool {
    let mut buf = vec![0u8; 65536];
    let mut cmsg_buf = vec![0u8; 1024];

    let mut iov = libc::iovec {
        iov_base: buf.as_mut_ptr() as *mut c_void,
        iov_len: buf.len(),
    };

    let mut msg = msghdr {
        msg_name: std::ptr::null_mut(),
        msg_namelen: 0,
        msg_iov: &mut iov,
        msg_iovlen: 1,
        msg_control: cmsg_buf.as_mut_ptr() as *mut c_void,
        msg_controllen: cmsg_buf.len(),
        msg_flags: 0,
    };

    let n = loop {
        let ret = unsafe { libc::recvmsg(from, &mut msg, libc::MSG_CMSG_CLOEXEC) };
        if ret < 0 && unsafe { *libc::__errno_location() } == libc::EINTR {
            continue;
        }
        break ret;
    };

    if n <= 0 {
        return false;
    }

    let cmsg_ptr = msg.msg_control;
    let cmsg_len = msg.msg_controllen;
    let cmsg = if cmsg_len > 0 && !cmsg_ptr.is_null() {
        let bytes = unsafe { std::slice::from_raw_parts(cmsg_ptr as *const u8, cmsg_len as usize) }
            .to_vec();
        let fds = extract_fds(cmsg_ptr, cmsg_len);
        Some(Cmsg { bytes, fds })
    } else {
        None
    };

    // Acquire the protocol write lock before mutating state / writing outbound
    // bytes, mirroring the original lock ordering.
    let write_lock = if dir == Direction::Outbound {
        CONNECTIONS
            .get()
            .and_then(|m| m.lock().ok())
            .and_then(|map| map.get(&app_fd).and_then(|h| h.write_lock()))
    } else {
        None
    };
    let write_guard = match &write_lock {
        Some(l) => match l.lock() {
            Ok(g) => Some(g),
            Err(_) => return false,
        },
        None => None,
    };

    let filtered = {
        let Some(m) = CONNECTIONS.get() else {
            return false;
        };
        let Ok(mut map) = m.lock() else {
            return false;
        };
        match map.get_mut(&app_fd) {
            Some(h) => match h.filter(dir, &buf[..n as usize], cmsg) {
                Some(f) => f,
                None => return false,
            },
            None => {
                let fds = cmsg.map(|c| c.fds).unwrap_or_default();
                Filtered {
                    data: buf[..n as usize].to_vec(),
                    cmsg: Vec::new(),
                    fds_to_close: fds,
                }
            }
        }
    };

    if filtered.data.is_empty() {
        for fd in filtered.fds_to_close {
            if fd >= 0 {
                syscalls::call_close(fd);
            }
        }
        return true;
    }

    let mut total_sent = 0;
    while total_sent < filtered.data.len() {
        let remaining = &filtered.data[total_sent..];
        let mut iov_out = libc::iovec {
            iov_base: remaining.as_ptr() as *mut c_void,
            iov_len: remaining.len(),
        };
        msg.msg_iov = &mut iov_out;
        msg.msg_iovlen = 1;

        if !filtered.cmsg.is_empty() && total_sent == 0 {
            let mut ctrl_slice: msghdr = msg;
            ctrl_slice.msg_control = filtered.cmsg.as_ptr() as *mut c_void;
            ctrl_slice.msg_controllen = filtered.cmsg.len();

            let sent = loop {
                let ret = unsafe { libc::sendmsg(to, &ctrl_slice, libc::MSG_NOSIGNAL) };
                if ret < 0 && unsafe { *libc::__errno_location() } == libc::EINTR {
                    continue;
                }
                break ret;
            };

            if sent <= 0 {
                break;
            }
            total_sent += sent as usize;
        } else {
            msg.msg_control = std::ptr::null_mut();
            msg.msg_controllen = 0;

            let sent = loop {
                let ret = unsafe { libc::sendmsg(to, &msg, libc::MSG_NOSIGNAL) };
                if ret < 0 && unsafe { *libc::__errno_location() } == libc::EINTR {
                    continue;
                }
                break ret;
            };

            if sent <= 0 {
                break;
            }
            total_sent += sent as usize;
        }
    }

    for fd in filtered.fds_to_close {
        if fd >= 0 {
            syscalls::call_close(fd);
        }
    }
    drop(write_guard);
    drop(write_lock);

    true
}

fn proxy_loop(app_fd: RawFd, proxy_fd: RawFd, real_fd: RawFd) {
    let mut fds = [
        libc::pollfd {
            fd: proxy_fd,
            events: libc::POLLIN,
            revents: 0,
        },
        libc::pollfd {
            fd: real_fd,
            events: libc::POLLIN,
            revents: 0,
        },
    ];

    loop {
        let ret = unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) };
        if ret < 0 {
            let err = unsafe { *libc::__errno_location() };
            if err == libc::EINTR {
                continue;
            }
            break;
        }

        if fds[0].revents & (libc::POLLIN | libc::POLLERR | libc::POLLHUP) != 0
            && !forward_msg(proxy_fd, real_fd, Direction::Outbound, app_fd)
        {
            break;
        }

        if fds[1].revents & (libc::POLLIN | libc::POLLERR | libc::POLLHUP) != 0
            && !forward_msg(real_fd, proxy_fd, Direction::Inbound, app_fd)
        {
            break;
        }
    }

    remove_connection(app_fd, Some(real_fd));
    syscalls::call_close(proxy_fd);
    syscalls::call_close(real_fd);
}

/// Remove one connection and run its protocol cleanup. When `expected_real_fd`
/// is supplied, the mapping is removed only if it still belongs to that proxy
/// thread; this protects a newly-reused `app_fd` from an old thread's teardown.
fn remove_connection(app_fd: RawFd, expected_real_fd: Option<RawFd>) {
    let Some(lifecycle) = CONNECTION_LIFECYCLE.get() else {
        return;
    };
    let Ok(_lifecycle_guard) = lifecycle.lock() else {
        return;
    };

    if let Some(expected_real_fd) = expected_real_fd {
        let matches = SINKS
            .get()
            .and_then(|m| m.lock().ok())
            .and_then(|map| {
                map.get(&app_fd)
                    .map(|sink| sink.real_fd == expected_real_fd)
            })
            .unwrap_or(false);
        if !matches {
            return;
        }
    }

    if let Some(m) = SINKS.get()
        && let Ok(mut map) = m.lock()
    {
        map.remove(&app_fd);
    }
    let handler = CONNECTIONS
        .get()
        .and_then(|m| m.lock().ok())
        .and_then(|mut map| map.remove(&app_fd));

    if let Some(mut handler) = handler {
        handler.on_close();
    }
}

// ── Hook callbacks ─────────────────────────────────────────────────────────

extern "C" fn hook_connect(fd: c_int, addr: *const c_void, addrlen: u32) -> c_int {
    let Some(proto) = find_protocol(addr, addrlen) else {
        return syscalls::call_connect(fd, addr, addrlen);
    };

    let real_fd = unsafe { libc::socket(AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if real_fd < 0 {
        return -1;
    }

    let ret = syscalls::call_connect(real_fd, addr, addrlen);
    if ret < 0 {
        let err = unsafe { *libc::__errno_location() };
        syscalls::call_close(real_fd);
        unsafe { *libc::__errno_location() = err };
        return ret;
    }

    let mut pair = [0; 2];
    if unsafe {
        libc::socketpair(
            AF_UNIX,
            libc::SOCK_STREAM | libc::SOCK_CLOEXEC,
            0,
            pair.as_mut_ptr(),
        )
    } < 0
    {
        let err = unsafe { *libc::__errno_location() };
        syscalls::call_close(real_fd);
        unsafe { *libc::__errno_location() = err };
        return -1;
    }

    let fd_flags = unsafe { libc::fcntl(fd, libc::F_GETFD, 0) };
    let fl_flags = unsafe { libc::fcntl(fd, libc::F_GETFL, 0) };

    if unsafe { libc::dup2(pair[0], fd) } < 0 {
        let err = unsafe { *libc::__errno_location() };
        syscalls::call_close(real_fd);
        syscalls::call_close(pair[0]);
        syscalls::call_close(pair[1]);
        unsafe { *libc::__errno_location() = err };
        return -1;
    }
    syscalls::call_close(pair[0]);

    if fd_flags >= 0 {
        unsafe { libc::fcntl(fd, libc::F_SETFD, fd_flags) };
    }
    if fl_flags >= 0 {
        unsafe { libc::fcntl(fd, libc::F_SETFL, fl_flags) };
    }

    let handler = proto.spawn(fd, real_fd);
    let sink = Sink {
        real_fd,
        app_fd: fd,
        write_lock: handler.write_lock(),
    };

    if let Some(lifecycle) = CONNECTION_LIFECYCLE.get()
        && let Ok(_lifecycle_guard) = lifecycle.lock()
    {
        if let Some(m) = CONNECTIONS.get()
            && let Ok(mut map) = m.lock()
        {
            map.insert(fd, handler);
        }
        if let Some(m) = SINKS.get()
            && let Ok(mut map) = m.lock()
        {
            map.insert(fd, sink);
        }
    }

    let proxy_fd = pair[1];
    std::thread::spawn(move || {
        proxy_loop(fd, proxy_fd, real_fd);
    });

    0
}

extern "C" fn hook_close(fd: c_int) -> c_int {
    remove_connection(fd, None);
    syscalls::call_close(fd)
}

// ── Hook installation ─────────────────────────────────────────────────────

macro_rules! install_hook {
    ($addr_slot:expr, $name:literal, $detour_fn:expr) => {{
        let sym = unsafe { dlsym(RTLD_DEFAULT, concat!($name, "\0").as_ptr() as *const _) };
        if sym.is_null() {
            eprintln!("[proxy] symbol not found: {} — hook setup aborted", $name);
            return;
        }
        let target_addr = sym as usize as u64;
        if $addr_slot.set(target_addr).is_err() {
            eprintln!("[proxy] target address slot for {} already set", $name);
            return;
        }
        if let Err(e) = inline_hook_jump(target_addr, $detour_fn as *const () as usize as u64) {
            eprintln!("[proxy] failed to enable hook for {}: {}", $name, e);
            return;
        }
    }};
}

pub(crate) fn init_hooks() {
    CONNECTIONS.get_or_init(|| Mutex::new(HashMap::new()));
    SINKS.get_or_init(|| Mutex::new(HashMap::new()));
    CONNECTION_LIFECYCLE.get_or_init(|| Mutex::new(()));

    super::wayland::init_state();
    super::x11::init_state();

    PROTOCOLS.get_or_init(|| {
        vec![
            Box::new(super::wayland::WaylandProtocol),
            Box::new(super::x11::X11Protocol),
        ]
    });

    install_hook!(HOOK_CONNECT_ADDR, "connect", hook_connect);
    install_hook!(HOOK_CLOSE_ADDR, "close", hook_close);
}

pub(crate) fn remove_hooks() {
    if let Some(lifecycle) = CONNECTION_LIFECYCLE.get()
        && let Ok(_lifecycle_guard) = lifecycle.lock()
    {
        if let Some(m) = CONNECTIONS.get()
            && let Ok(mut map) = m.lock()
        {
            map.clear();
        }
        if let Some(m) = SINKS.get()
            && let Ok(mut map) = m.lock()
        {
            map.clear();
        }
    }

    super::wayland::clear_state();
    super::x11::clear_state();

    if let Some(addr) = HOOK_CLOSE_ADDR.get() {
        let _ = unhook(*addr);
    }
    if let Some(addr) = HOOK_CONNECT_ADDR.get() {
        let _ = unhook(*addr);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use super::*;

    struct CleanupCounter(Arc<AtomicUsize>);

    impl ConnectionHandler for CleanupCounter {
        fn filter(
            &mut self,
            _dir: Direction,
            _chunk: &[u8],
            _cmsg: Option<Cmsg>,
        ) -> Option<Filtered> {
            unreachable!()
        }

        fn on_close(&mut self) {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
    }

    #[test]
    fn proxy_teardown_does_not_remove_a_reused_fd() {
        CONNECTIONS.get_or_init(|| Mutex::new(HashMap::new()));
        SINKS.get_or_init(|| Mutex::new(HashMap::new()));
        CONNECTION_LIFECYCLE.get_or_init(|| Mutex::new(()));

        let app_fd = 93_001;
        let real_fd = 93_002;
        let cleanup_count = Arc::new(AtomicUsize::new(0));
        CONNECTIONS
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .insert(app_fd, Box::new(CleanupCounter(Arc::clone(&cleanup_count))));
        SINKS.get().unwrap().lock().unwrap().insert(
            app_fd,
            Sink {
                real_fd,
                app_fd,
                write_lock: None,
            },
        );

        remove_connection(app_fd, Some(real_fd + 1));
        assert!(
            CONNECTIONS
                .get()
                .unwrap()
                .lock()
                .unwrap()
                .contains_key(&app_fd)
        );
        assert_eq!(cleanup_count.load(Ordering::Relaxed), 0);

        remove_connection(app_fd, Some(real_fd));
        assert!(
            !CONNECTIONS
                .get()
                .unwrap()
                .lock()
                .unwrap()
                .contains_key(&app_fd)
        );
        assert!(!SINKS.get().unwrap().lock().unwrap().contains_key(&app_fd));
        assert_eq!(cleanup_count.load(Ordering::Relaxed), 1);
    }
}
