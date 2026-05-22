use std::{
    collections::HashMap,
    os::fd::RawFd,
    sync::{Mutex, OnceLock},
};

use libc::{
    AF_UNIX, RTLD_DEFAULT, SYS_close, SYS_connect, c_int, c_long, c_void, dlsym, msghdr, syscall,
};
use sighook::{inline_hook_jump, unhook};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Protocol {
    Wayland,
    X11,
}

// ── Hook metadata ─────────────────────────────────────────────────────────

static HOOK_CONNECT_ADDR: OnceLock<u64> = OnceLock::new();
static HOOK_CLOSE_ADDR: OnceLock<u64> = OnceLock::new();

/// Tracks which proxy protocol is active for each application-side file descriptor.
static PROTOCOLS: OnceLock<Mutex<HashMap<RawFd, Protocol>>> = OnceLock::new();

// ── Syscall helpers ────────────────────────────────────────────────────────

#[inline]
fn raw_syscall_ret(num: c_long, args: &[usize]) -> c_long {
    unsafe {
        match args {
            [a0] => syscall(num, *a0),
            [a0, a1] => syscall(num, *a0, *a1),
            [a0, a1, a2] => syscall(num, *a0, *a1, *a2),
            _ => -1,
        }
    }
}

#[inline]
fn call_connect(fd: c_int, addr: *const c_void, addrlen: u32) -> c_int {
    raw_syscall_ret(
        SYS_connect as c_long,
        &[fd as usize, addr as usize, addrlen as usize],
    ) as c_int
}

#[inline]
pub(crate) fn call_close(fd: c_int) -> c_int {
    raw_syscall_ret(SYS_close as c_long, &[fd as usize]) as c_int
}

/// Sends raw bytes on the given fd. Injects data naturally proxying it.
pub(crate) fn send_raw_msg(fd: RawFd, data: &[u8]) -> bool {
    let mut iov = libc::iovec {
        iov_base: data.as_ptr() as *mut c_void,
        iov_len: data.len(),
    };
    let msg = msghdr {
        msg_name: std::ptr::null_mut(),
        msg_namelen: 0,
        msg_iov: &mut iov as *mut libc::iovec,
        msg_iovlen: 1,
        msg_control: std::ptr::null_mut(),
        msg_controllen: 0,
        msg_flags: 0,
    };
    let ret = unsafe { libc::sendmsg(fd, &msg as *const msghdr, libc::MSG_NOSIGNAL) };
    ret as usize == data.len()
}

// ── Proxy MITM Helpers ────────────────────────────────────────────────────

fn forward_msg(from: RawFd, to: RawFd, is_event: bool, app_fd: RawFd, proto: Protocol) -> bool {
    let mut buf = vec![0u8; 65536];
    let mut cmsg_buf = vec![0u8; 1024];

    let mut iov = libc::iovec {
        iov_base: buf.as_mut_ptr() as *mut c_void,
        iov_len: buf.len(),
    };

    let mut msg = libc::msghdr {
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

    let data = &mut buf[..n as usize];

    let cmsg_ptr = msg.msg_control;
    let cmsg_len = msg.msg_controllen;
    let cmsg_has_data = cmsg_len > 0 && !cmsg_ptr.is_null();

    let (out_data, ctrl_data, close_fds) = match proto {
        Protocol::Wayland => {
            let cmsg_slice = if cmsg_has_data {
                let cmsg_bytes =
                    unsafe { std::slice::from_raw_parts(cmsg_ptr as *const u8, cmsg_len as usize) };
                let mut fds = Vec::new();
                let msg_for_scan = libc::msghdr {
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
                        if (*cmsg).cmsg_level == libc::SOL_SOCKET
                            && (*cmsg).cmsg_type == libc::SCM_RIGHTS
                        {
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
                Some((cmsg_bytes, fds))
            } else {
                None
            };
            if is_event {
                super::wayland::feed_inbound(app_fd, data, cmsg_slice)
            } else {
                super::wayland::feed_outbound(app_fd, data, cmsg_slice)
            }
        }
        Protocol::X11 => {
            // X11 doesn't use ancillary data in the same way - no control data to track
            let Some(out) = (if is_event {
                super::x11::feed_inbound(app_fd, data)
            } else {
                super::x11::feed_outbound(app_fd, data)
            }) else {
                return false;
            };
            (out, Vec::new(), Vec::new())
        }
    };

    if out_data.is_empty() {
        for fd in close_fds {
            if fd >= 0 {
                call_close(fd);
            }
        }
        return true;
    }

    let mut total_sent = 0;
    while total_sent < out_data.len() {
        let remaining = &out_data[total_sent..];
        let mut iov_out = libc::iovec {
            iov_base: remaining.as_ptr() as *mut c_void,
            iov_len: remaining.len(),
        };
        msg.msg_iov = &mut iov_out;
        msg.msg_iovlen = 1;

        if !ctrl_data.is_empty() && total_sent == 0 {
            let mut ctrl_slice: libc::msghdr = msg;
            ctrl_slice.msg_control = ctrl_data.as_ptr() as *mut c_void;
            ctrl_slice.msg_controllen = ctrl_data.len();

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

    for fd in close_fds {
        if fd >= 0 {
            call_close(fd);
        }
    }

    true
}

fn proxy_loop(app_fd: RawFd, proxy_fd: RawFd, real_fd: RawFd, proto: Protocol) {
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
            && !forward_msg(proxy_fd, real_fd, false, app_fd, proto)
        {
            break;
        }

        if fds[1].revents & (libc::POLLIN | libc::POLLERR | libc::POLLHUP) != 0
            && !forward_msg(real_fd, proxy_fd, true, app_fd, proto)
        {
            break;
        }
    }

    call_close(proxy_fd);
    call_close(real_fd);
}

// ── Hook callbacks ─────────────────────────────────────────────────────────

extern "C" fn hook_connect(fd: c_int, addr: *const c_void, addrlen: u32) -> c_int {
    let is_wl = super::wayland::is_wayland_socket(addr, addrlen);
    let is_x11 = super::x11::is_x11_socket(addr, addrlen);

    if !is_wl && !is_x11 {
        return call_connect(fd, addr, addrlen);
    }

    let real_fd = unsafe { libc::socket(AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if real_fd < 0 {
        return -1;
    }

    let ret = call_connect(real_fd, addr, addrlen);
    if ret < 0 {
        let err = unsafe { *libc::__errno_location() };
        call_close(real_fd);
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
        call_close(real_fd);
        unsafe { *libc::__errno_location() = err };
        return -1;
    }

    let fd_flags = unsafe { libc::fcntl(fd, libc::F_GETFD, 0) };
    let fl_flags = unsafe { libc::fcntl(fd, libc::F_GETFL, 0) };

    if unsafe { libc::dup2(pair[0], fd) } < 0 {
        let err = unsafe { *libc::__errno_location() };
        call_close(real_fd);
        call_close(pair[0]);
        call_close(pair[1]);
        unsafe { *libc::__errno_location() = err };
        return -1;
    }
    call_close(pair[0]);

    if fd_flags >= 0 {
        unsafe { libc::fcntl(fd, libc::F_SETFD, fd_flags) };
    }
    if fl_flags >= 0 {
        unsafe { libc::fcntl(fd, libc::F_SETFL, fl_flags) };
    }

    let proto = if is_wl {
        Protocol::Wayland
    } else {
        Protocol::X11
    };

    if let Some(m) = PROTOCOLS.get()
        && let Ok(mut map) = m.lock()
    {
        map.insert(fd, proto);
    }

    match proto {
        Protocol::Wayland => super::wayland::on_new_connection(fd),
        Protocol::X11 => super::x11::on_new_connection(fd, real_fd),
    }

    let proxy_fd = pair[1];
    std::thread::spawn(move || {
        proxy_loop(fd, proxy_fd, real_fd, proto);
    });

    0
}

extern "C" fn hook_close(fd: c_int) -> c_int {
    let proto = PROTOCOLS
        .get()
        .and_then(|m| m.lock().ok())
        .and_then(|mut map| map.remove(&fd));

    if let Some(p) = proto {
        match p {
            Protocol::Wayland => super::wayland::on_close(fd),
            Protocol::X11 => super::x11::on_close(fd),
        }
    }
    call_close(fd)
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

pub(super) fn init_hooks() {
    PROTOCOLS.get_or_init(|| Mutex::new(HashMap::new()));
    super::wayland::init_state();
    super::x11::init_state();

    install_hook!(HOOK_CONNECT_ADDR, "connect", hook_connect);
    install_hook!(HOOK_CLOSE_ADDR, "close", hook_close);
}

pub(super) fn remove_hooks() {
    if let Some(m) = PROTOCOLS.get()
        && let Ok(mut map) = m.lock()
    {
        map.clear();
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
