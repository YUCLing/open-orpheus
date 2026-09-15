use std::{mem, os::fd::RawFd};

use libc::{AF_UNIX, c_void, sa_family_t, sockaddr, sockaddr_un};

// ── XI2 constants ──────────────────────────────────────────────────────────

/// Core `GenericEvent` code carrying XI2 events.
pub(crate) const XI_GENERIC_EVENT: u8 = 35;
/// XI2 event types (absolute enum values in the `GenericEvent` evtype field).
pub(crate) const XI_EV_TOUCH_BEGIN: u16 = 18;
pub(crate) const XI_EV_TOUCH_END: u16 = 20;
/// XI2 extension request opcodes (second byte after the XI major opcode).
/// XIAllowTouchEvents (XI 2.2) reuses the XIAllowEvents request with the
/// extended `xXI2_2AllowEventsReq` body; there is no separate opcode.
pub(crate) const XI_ALLOW_EVENTS: u8 = 53;
/// XIAllowTouchEvents event modes (`mode` field of `xXI2_2AllowEventsReq`).
/// (XIAsyncDevice=0 … XISyncPair=5, XIAcceptTouch=6.) Reject hands the
/// sequence over to core-pointer emulation.
pub(crate) const XI_REJECT_TOUCH: u32 = 7;

pub(crate) fn checked_word_len(words: usize) -> Option<usize> {
    words.checked_mul(4)
}

pub(crate) fn log_parser_close(fd: RawFd, direction: &str, reason: &str, buffered: usize) {
    eprintln!("[proxy:x11] closing {direction} stream for fd {fd}: {reason}; buffered={buffered}");
}

#[inline]
pub(crate) fn r16(b: &[u8], le: bool) -> u16 {
    if le {
        u16::from_le_bytes(b[0..2].try_into().unwrap())
    } else {
        u16::from_be_bytes(b[0..2].try_into().unwrap())
    }
}

#[inline]
pub(crate) fn r32(b: &[u8], le: bool) -> u32 {
    if le {
        u32::from_le_bytes(b[0..4].try_into().unwrap())
    } else {
        u32::from_be_bytes(b[0..4].try_into().unwrap())
    }
}

#[inline]
pub(crate) fn write_u16(b: &mut [u8], v: u16, le: bool) {
    b[0..2].copy_from_slice(&(if le { v.to_le_bytes() } else { v.to_be_bytes() }));
}

#[inline]
pub(crate) fn write_u32(b: &mut [u8], v: u32, le: bool) {
    b[0..4].copy_from_slice(&(if le { v.to_le_bytes() } else { v.to_be_bytes() }));
}

pub(crate) fn is_x11_socket(addr: *const c_void, addrlen: u32) -> bool {
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
    candidate.windows(11).any(|w| w == b".X11-unix/X")
}

#[cfg(test)]
mod tests {
    use std::mem::offset_of;

    use libc::{AF_INET, AF_UNIX, c_char, c_void, sa_family_t, sockaddr_un};

    use super::{checked_word_len, is_x11_socket, r16, r32, write_u16, write_u32};

    /// Build a unix-domain socket address holding `name`.
    fn unix_addr(name: &[u8]) -> (sockaddr_un, u32) {
        let mut sun: sockaddr_un = unsafe { std::mem::zeroed() };
        sun.sun_family = AF_UNIX as sa_family_t;
        for (i, byte) in name.iter().enumerate() {
            sun.sun_path[i] = *byte as c_char;
        }
        let addrlen = (offset_of!(sockaddr_un, sun_path) + name.len()) as u32;
        (sun, addrlen)
    }

    fn is_x11_named(name: &[u8]) -> bool {
        let (sun, addrlen) = unix_addr(name);
        is_x11_socket(&sun as *const _ as *const c_void, addrlen)
    }

    #[test]
    fn word_lengths_are_checked_for_overflow() {
        assert_eq!(checked_word_len(0), Some(0));
        assert_eq!(checked_word_len(1), Some(4));
        assert_eq!(checked_word_len(256), Some(1_024));
        assert_eq!(checked_word_len(usize::MAX), None);
        assert_eq!(checked_word_len(usize::MAX / 4 + 1), None);
    }

    #[test]
    fn reads_honour_the_endianness_of_the_stream() {
        let bytes = [0x34, 0x12, 0x78, 0x56];

        assert_eq!(r16(&bytes, true), 0x1234);
        assert_eq!(r32(&bytes, true), 0x5678_1234);
        assert_eq!(r16(&bytes, false), 0x3412);
        assert_eq!(r32(&bytes, false), 0x3412_7856);
    }

    #[test]
    fn writes_round_trip_through_the_readers() {
        for le in [true, false] {
            let mut buf = [0u8; 4];
            write_u16(&mut buf, 0xBEEF, le);
            assert_eq!(r16(&buf, le), 0xBEEF, "le={le}");
            assert_eq!(&buf[2..], &[0, 0], "a 16-bit write stays in its half");

            write_u32(&mut buf, 0xDEAD_BEEF, le);
            assert_eq!(r32(&buf, le), 0xDEAD_BEEF, "le={le}");
        }
    }

    #[test]
    fn a_null_or_short_address_is_rejected() {
        assert!(!is_x11_socket(std::ptr::null(), 32));

        let (sun, _) = unix_addr(b"/tmp/.X11-unix/X0");
        assert!(!is_x11_socket(&sun as *const _ as *const c_void, 0));
        assert!(!is_x11_socket(&sun as *const _ as *const c_void, 1));
    }

    #[test]
    fn only_unix_sockets_are_considered() {
        let mut sun: sockaddr_un = unsafe { std::mem::zeroed() };
        sun.sun_family = AF_INET as sa_family_t;
        let name = b"/tmp/.X11-unix/X0";
        for (i, byte) in name.iter().enumerate() {
            sun.sun_path[i] = *byte as c_char;
        }
        let addrlen = (offset_of!(sockaddr_un, sun_path) + name.len()) as u32;

        assert!(!is_x11_socket(&sun as *const _ as *const c_void, addrlen));
    }

    #[test]
    fn pathname_and_abstract_x11_sockets_are_detected() {
        assert!(is_x11_named(b"/tmp/.X11-unix/X0"));
        assert!(is_x11_named(b"/tmp/.X11-unix/X99"));
        assert!(is_x11_named(b"\0/tmp/.X11-unix/X0"), "abstract socket");
        assert!(is_x11_named(b".X11-unix/X"), "marker at the start");
    }

    #[test]
    fn unrelated_sockets_are_not_mistaken_for_x11() {
        assert!(!is_x11_named(b"/run/user/1000/wayland-0"));
        assert!(!is_x11_named(b"/tmp/.X11-unix"));
        assert!(!is_x11_named(b"/tmp/.X11-unix/"), "no display number");
        assert!(!is_x11_named(b""));
        assert!(!is_x11_named(b"\0"));
    }
}
