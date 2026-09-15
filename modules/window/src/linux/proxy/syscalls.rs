use std::os::fd::RawFd;

use libc::{c_int, c_long, c_void, msghdr, syscall};

/// Invoke a raw syscall with a variable number of arguments.
#[inline]
pub(crate) fn raw_syscall_ret(num: c_long, args: &[usize]) -> c_long {
    unsafe {
        match args {
            [a0] => syscall(num, *a0),
            [a0, a1] => syscall(num, *a0, *a1),
            [a0, a1, a2] => syscall(num, *a0, *a1, *a2),
            _ => -1,
        }
    }
}

/// Wrapper around the `connect` syscall.
#[inline]
pub(crate) fn call_connect(fd: c_int, addr: *const c_void, addrlen: u32) -> c_int {
    raw_syscall_ret(
        libc::SYS_connect as c_long,
        &[fd as usize, addr as usize, addrlen as usize],
    ) as c_int
}

/// Wrapper around the `close` syscall.
#[inline]
pub(crate) fn call_close(fd: c_int) -> c_int {
    raw_syscall_ret(libc::SYS_close as c_long, &[fd as usize]) as c_int
}

/// How a `sendmsg` of a `len`-byte payload ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SendOutcome {
    /// Every byte reached the socket buffer.
    Complete,
    /// Some bytes were written and the rest were not: the two ends of the
    /// stream no longer agree on where messages start.
    Partial,
    /// Nothing was written, so no bytes are lost.
    Failed,
}

/// Classify the raw return value of `sendmsg`.
fn classify_send(ret: isize, len: usize) -> SendOutcome {
    if ret < 0 {
        SendOutcome::Failed
    } else if ret as usize == len {
        SendOutcome::Complete
    } else if ret == 0 {
        // Only reachable for a non-empty payload: the kernel took nothing.
        SendOutcome::Failed
    } else {
        SendOutcome::Partial
    }
}

/// Sends raw bytes on the given fd. Injects data naturally proxying it.
///
/// Only for single control messages (a few dozen bytes). The write is never
/// retried, so a payload larger than the socket buffer could be truncated;
/// `true` means every byte was handed to the kernel.
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

    match classify_send(ret, data.len()) {
        SendOutcome::Complete => true,
        SendOutcome::Partial => {
            // Retrying cannot repair this: the bytes already in the socket are
            // part of the protocol stream, which is now desynced.
            eprintln!(
                "[proxy] short send on fd {fd}: {ret} of {} bytes",
                data.len()
            );
            false
        }
        // Nothing was written, so the caller may retry or give up. This is also
        // what a closing connection looks like (EBADF/EPIPE), so it is not logged.
        SendOutcome::Failed => false,
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read;
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    use super::*;

    #[test]
    fn send_raw_msg_delivers_the_whole_payload() {
        let (writer, mut reader) = UnixStream::pair().expect("socketpair");
        reader
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("timeout");

        assert!(send_raw_msg(writer.as_raw_fd(), b"hello"));

        let mut buf = [0u8; 5];
        reader.read_exact(&mut buf).expect("payload arrives");
        assert_eq!(&buf, b"hello");
    }

    #[test]
    fn send_raw_msg_reports_failure_when_nothing_can_be_sent() {
        assert!(!send_raw_msg(-1, b"hello"));
    }

    #[test]
    fn call_close_closes_a_real_descriptor() {
        let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
        assert!(fd >= 0, "could not create a socket");

        assert_eq!(call_close(fd), 0, "the socket is closed");
        // A descriptor that was never valid reports failure. Asserting on the
        // closed fd instead would depend on its number not being reallocated.
        assert_eq!(call_close(-1), -1, "EBADF");
    }

    #[test]
    fn raw_syscall_ret_refuses_unsupported_arities() {
        // No syscall is issued for these: the wrapper bails out instead of
        // guessing how the arguments should be passed.
        assert_eq!(raw_syscall_ret(libc::SYS_getpid as c_long, &[]), -1);
        assert_eq!(
            raw_syscall_ret(libc::SYS_getpid as c_long, &[0, 0, 0, 0]),
            -1
        );
    }

    #[test]
    fn a_full_write_is_complete() {
        assert_eq!(classify_send(16, 16), SendOutcome::Complete);
        assert_eq!(classify_send(0, 0), SendOutcome::Complete, "empty payload");
    }

    #[test]
    fn a_short_write_is_partial() {
        assert_eq!(classify_send(8, 16), SendOutcome::Partial);
        assert_eq!(classify_send(1, 16), SendOutcome::Partial);
    }

    #[test]
    fn writing_nothing_loses_nothing() {
        assert_eq!(classify_send(-1, 16), SendOutcome::Failed, "EBADF/EPIPE");
        assert_eq!(classify_send(0, 16), SendOutcome::Failed, "would block");
    }
}
