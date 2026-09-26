use std::mem;

use libc::{AF_UNIX, c_void, sa_family_t, sockaddr, sockaddr_un};

// ── Object interface tags ──────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Iface {
    WlDisplay,
    WlRegistry,
    WlCompositor,
    WlSeat,
    WlPointer,
    WlTouch,
    WlSurface,
    XdgWmBase,
    XdgSurface,
    XdgToplevel,
    /// A `zwlr_layer_shell_v1` object the proxy bound for itself.
    ZwlrLayerShell,
    /// A layer surface the client believes is an `xdg_toplevel`. Requests it
    /// sends use xdg-toplevel opcodes; events it receives use layer opcodes.
    ZwlrLayerSurface,
    /// The client's `zxdg_decoration_manager_v1`.
    ZxdgDecorationManager,
    /// A decoration object the compositor never created, because the toplevel
    /// it names does not exist there.
    ZxdgToplevelDecoration,
    /// The client's `xdg_toplevel_icon_manager_v1`.
    XdgToplevelIconManager,
}

// ── Message opcodes ────────────────────────────────────────────────────────

pub(crate) const EVT_DELETE_ID: u16 = 1;
pub(crate) const REQ_GET_REGISTRY: u16 = 1;
pub(crate) const REQ_BIND: u16 = 0;
pub(crate) const REQ_CREATE_SURFACE: u16 = 0;
pub(crate) const REQ_CREATE_REGION: u16 = 1;
pub(crate) const REQ_GET_POINTER: u16 = 0;
pub(crate) const REQ_GET_TOUCH: u16 = 2;
pub(crate) const EVT_ENTER: u16 = 0;
pub(crate) const EVT_LEAVE: u16 = 1;
pub(crate) const EVT_BUTTON: u16 = 3;
pub(crate) const BTN_PRESSED: u32 = 1;
pub(crate) const EVT_TOUCH_DOWN: u16 = 0;
pub(crate) const WL_TOUCH_RELEASE: u16 = 0;
pub(crate) const REQ_GET_XDG_SURFACE: u16 = 2;
pub(crate) const REQ_GET_TOPLEVEL: u16 = 1;
pub(crate) const REQ_GET_POPUP: u16 = 2;
pub(crate) const REQ_SET_WINDOW_GEOMETRY: u16 = 3;
pub(crate) const REQ_ACK_CONFIGURE: u16 = 4;
pub(crate) const REQ_SET_TITLE: u16 = 2;
pub(crate) const REQ_MOVE: u16 = 5;
pub(crate) const REQ_SET_INPUT_REGION: u16 = 5;
pub(crate) const WL_POINTER_RELEASE: u16 = 1;
pub(crate) const REQ_DESTROY: u16 = 0;
pub(crate) const REQ_REGION_DESTROY: u16 = 0;
pub(crate) const REQ_REGION_ADD: u16 = 1;

// wl_registry events
pub(crate) const EVT_GLOBAL: u16 = 0;
pub(crate) const EVT_GLOBAL_REMOVE: u16 = 1;

// xdg_toplevel events
pub(crate) const EVT_TOPLEVEL_CONFIGURE: u16 = 0;
pub(crate) const EVT_TOPLEVEL_CLOSE: u16 = 1;

// zwlr_layer_shell_v1 requests
pub(crate) const REQ_GET_LAYER_SURFACE: u16 = 0;

// zwlr_layer_surface_v1 requests
pub(crate) const REQ_LAYER_SET_SIZE: u16 = 0;
pub(crate) const REQ_LAYER_SET_ANCHOR: u16 = 1;
pub(crate) const REQ_LAYER_SET_EXCLUSIVE_ZONE: u16 = 2;
pub(crate) const REQ_LAYER_SET_MARGIN: u16 = 3;
pub(crate) const REQ_LAYER_SET_KEYBOARD_INTERACTIVITY: u16 = 4;
pub(crate) const REQ_LAYER_GET_POPUP: u16 = 5;
pub(crate) const REQ_LAYER_ACK_CONFIGURE: u16 = 6;
pub(crate) const REQ_LAYER_DESTROY: u16 = 7;

// zwlr_layer_surface_v1 events
pub(crate) const EVT_LAYER_CONFIGURE: u16 = 0;
pub(crate) const EVT_LAYER_CLOSED: u16 = 1;

// zxdg_decoration_manager_v1 requests
pub(crate) const REQ_GET_TOPLEVEL_DECORATION: u16 = 1;

// zxdg_toplevel_decoration_v1 requests and events
pub(crate) const REQ_DECORATION_DESTROY: u16 = 0;
pub(crate) const EVT_DECORATION_CONFIGURE: u16 = 0;
pub(crate) const DECORATION_CLIENT_SIDE: u32 = 1;

// xdg_toplevel_icon_manager_v1 requests
pub(crate) const REQ_SET_ICON: u16 = 2;

// U+200B (Zero Width Space) and U+200C (Zero Width Non-Joiner)
pub(crate) const CUSTOM_ID_PREFIX: &str = "\u{200B}\u{200C}";

// ── Wire helpers ──────────────────────────────────────────────────────────

#[inline]
pub(crate) fn parse_header(buf: &[u8]) -> Option<(u32, u16, usize)> {
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
pub(crate) fn ru32(buf: &[u8], offset: usize) -> Option<u32> {
    buf.get(offset..offset + 4)
        .and_then(|b| b.try_into().ok())
        .map(u32::from_ne_bytes)
}

#[inline]
pub(crate) fn rfixed_i32(buf: &[u8], offset: usize) -> Option<i32> {
    buf.get(offset..offset + 4)
        .and_then(|b| b.try_into().ok())
        .map(i32::from_ne_bytes)
        .map(|value| value >> 8)
}

pub(crate) fn parse_wl_str(buf: &[u8], offset: usize) -> Option<(&str, usize)> {
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

// ── Message model ──────────────────────────────────────────────────────────

/// A single complete Wayland message (8-byte header + body).
pub(crate) struct WlMessage {
    pub(crate) object_id: u32,
    pub(crate) opcode: u16,
    body: Vec<u8>,
}

impl WlMessage {
    pub(crate) fn new(object_id: u32, opcode: u16, body: Vec<u8>) -> Self {
        Self {
            object_id,
            opcode,
            body,
        }
    }

    /// Full wire bytes of the message, for round-trip forwarding.
    pub(crate) fn raw(&self) -> &[u8] {
        &self.body
    }

    pub(crate) fn u32_arg(&self, offset: usize) -> Option<u32> {
        ru32(&self.body, offset)
    }

    pub(crate) fn fixed_arg(&self, offset: usize) -> Option<i32> {
        rfixed_i32(&self.body, offset)
    }

    /// Parses a length-prefixed string argument at `offset`.
    /// Returns the string and the offset just past its padded data.
    pub(crate) fn str_arg(&self, offset: usize) -> Option<(&str, usize)> {
        parse_wl_str(&self.body, offset)
    }

    pub(crate) fn str_text(&self, offset: usize) -> Option<&str> {
        parse_wl_str(&self.body, offset).map(|(s, _)| s)
    }
}

/// Drain complete messages from `buf`. Returns decoded messages and the number
/// of consumed bytes — the caller keeps the unconsumed tail for reassembly.
pub(crate) fn decode(buf: &[u8]) -> (Vec<WlMessage>, usize) {
    let mut msgs = Vec::new();
    let mut off = 0;
    while let Some((oid, op, sz)) = parse_header(&buf[off..]) {
        let Some(end) = off.checked_add(sz) else {
            break;
        };
        if end > buf.len() {
            break;
        }
        msgs.push(WlMessage::new(oid, op, buf[off..end].to_vec()));
        off = end;
    }
    (msgs, off)
}

// ── Socket detection ──────────────────────────────────────────────────────

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

#[cfg(test)]
mod tests {
    use std::mem::offset_of;

    use libc::{AF_INET, AF_UNIX, c_char, c_void, sa_family_t, sockaddr_un};

    use super::super::test_support::{declared_message, header, wl_string};
    use super::{
        WlMessage, decode, is_wayland_socket, parse_header, parse_wl_str, rfixed_i32, ru32,
    };

    fn fixed_bytes(value: i32) -> [u8; 4] {
        value.to_ne_bytes()
    }

    fn unix_addr(name: &[u8]) -> (sockaddr_un, u32) {
        let mut sun: sockaddr_un = unsafe { std::mem::zeroed() };
        sun.sun_family = AF_UNIX as sa_family_t;
        for (i, byte) in name.iter().enumerate() {
            sun.sun_path[i] = *byte as c_char;
        }
        let addrlen = (offset_of!(sockaddr_un, sun_path) + name.len()) as u32;
        (sun, addrlen)
    }

    fn is_wayland_named(name: &[u8]) -> bool {
        let (sun, addrlen) = unix_addr(name);
        is_wayland_socket(&sun as *const _ as *const c_void, addrlen)
    }

    #[test]
    fn headers_are_validated_before_use() {
        assert_eq!(parse_header(&[]), None);
        assert_eq!(parse_header(&[0; 7]), None);
        assert_eq!(parse_header(&header(1, 0, 0)), None, "size 0");
        assert_eq!(
            parse_header(&header(1, 0, 4)),
            None,
            "smaller than a header"
        );
        assert_eq!(parse_header(&header(1, 0, 10)), None, "not word aligned");
    }

    #[test]
    fn headers_expose_object_opcode_and_size() {
        assert_eq!(parse_header(&header(42, 3, 16)), Some((42, 3, 16)));
        assert_eq!(parse_header(&header(7, 1, 8)), Some((7, 1, 8)));
        assert_eq!(
            parse_header(&header(u32::MAX, u16::MAX, 65_532)),
            Some((u32::MAX, u16::MAX, 65_532)),
            "the size field is only 16 bits wide"
        );
    }

    #[test]
    fn reads_beyond_the_buffer_return_none() {
        let buf = [1u8, 2, 3, 4];

        assert_eq!(ru32(&buf, 0), Some(u32::from_ne_bytes(buf)));
        assert_eq!(ru32(&buf, 1), None);
        assert_eq!(ru32(&buf, 4), None);
        assert_eq!(rfixed_i32(&buf, 1), None);
        assert_eq!(parse_wl_str(&buf, 1), None, "no room for a length");
    }

    #[test]
    fn fixed_point_values_are_shifted_down() {
        assert_eq!(rfixed_i32(&fixed_bytes(384), 0), Some(1));
        assert_eq!(rfixed_i32(&fixed_bytes(-256), 0), Some(-1));
        assert_eq!(rfixed_i32(&fixed_bytes(255), 0), Some(0));
        assert_eq!(rfixed_i32(&fixed_bytes(0), 0), Some(0));
    }

    #[test]
    fn strings_are_parsed_and_padded_to_four_bytes() {
        let short = wl_string("hi");
        assert_eq!(parse_wl_str(&short, 0), Some(("hi", 8)));

        let long = wl_string("hello");
        assert_eq!(long.len(), 12, "length field + NUL + padding");
        assert_eq!(parse_wl_str(&long, 0), Some(("hello", 12)));

        let empty = wl_string("");
        assert_eq!(parse_wl_str(&empty, 0), Some(("", 8)));
    }

    #[test]
    fn malformed_strings_are_rejected() {
        let truncated = wl_string("hello")[..6].to_vec();
        assert_eq!(parse_wl_str(&truncated, 0), None);

        // A length that runs past the end of the buffer.
        let mut overlong = 64u32.to_ne_bytes().to_vec();
        overlong.extend_from_slice(b"short\0");
        assert_eq!(parse_wl_str(&overlong, 0), None);

        // Not valid UTF-8.
        let mut invalid = 3u32.to_ne_bytes().to_vec();
        invalid.extend_from_slice(&[0xFF, 0xFE, 0x00, 0x00]);
        assert_eq!(parse_wl_str(&invalid, 0), None);
    }

    #[test]
    fn a_missing_terminator_still_yields_the_raw_length() {
        let mut unterminated = 4u32.to_ne_bytes().to_vec();
        unterminated.extend_from_slice(b"abcd");

        assert_eq!(parse_wl_str(&unterminated, 0), Some(("abcd", 8)));
    }

    #[test]
    fn messages_expose_their_arguments() {
        let mut body = 7u32.to_ne_bytes().to_vec();
        body.extend_from_slice(&fixed_bytes(-256));
        body.extend_from_slice(&wl_string("abc"));
        let msg = WlMessage::new(11, 2, body.clone());

        assert_eq!(msg.object_id, 11);
        assert_eq!(msg.opcode, 2);
        assert_eq!(msg.raw(), body.as_slice(), "wire bytes are preserved");
        assert_eq!(msg.u32_arg(0), Some(7));
        assert_eq!(msg.fixed_arg(4), Some(-1));
        assert_eq!(msg.str_arg(8), Some(("abc", 16)));
        assert_eq!(msg.str_text(8), Some("abc"));
        assert_eq!(msg.u32_arg(252), None, "out of range");
    }

    #[test]
    fn decode_drains_complete_messages_only() {
        let mut buf = declared_message(1, 0, 8);
        buf.extend_from_slice(&declared_message(2, 5, 16));
        assert_eq!(buf.len(), 24);

        let (msgs, consumed) = decode(&buf);
        assert_eq!(consumed, 24);
        assert_eq!(msgs.len(), 2);
        assert_eq!(
            (msgs[0].object_id, msgs[0].opcode, msgs[0].raw().len()),
            (1, 0, 8)
        );
        assert_eq!(
            (msgs[1].object_id, msgs[1].opcode, msgs[1].raw().len()),
            (2, 5, 16)
        );

        // A partial header is left for the next read.
        buf.extend_from_slice(&[0xAA, 0xBB, 0xCC]);
        let (msgs, consumed) = decode(&buf);
        assert_eq!(consumed, 24);
        assert_eq!(msgs.len(), 2);
    }

    #[test]
    fn decode_keeps_an_incomplete_message_buffered() {
        let mut buf = declared_message(1, 0, 8);
        buf.extend_from_slice(&declared_message(2, 0, 32)[..16]);

        let (msgs, consumed) = decode(&buf);

        assert_eq!(consumed, 8, "only the complete message is consumed");
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].object_id, 1);
    }

    #[test]
    fn decode_reports_nothing_for_garbage() {
        assert_eq!(decode(&[]).1, 0);
        assert_eq!(decode(&[0; 4]).1, 0);
        assert_eq!(decode(&declared_message(1, 0, 6)).1, 0, "unaligned size");
        assert_eq!(decode(&declared_message(1, 0, 0)).1, 0, "zero size");
    }

    #[test]
    fn only_unix_sockets_are_considered() {
        assert!(!is_wayland_socket(std::ptr::null(), 32));

        let mut sun: sockaddr_un = unsafe { std::mem::zeroed() };
        sun.sun_family = AF_INET as sa_family_t;
        let name = b"/run/user/1000/wayland-0";
        for (i, byte) in name.iter().enumerate() {
            sun.sun_path[i] = *byte as c_char;
        }
        let addrlen = (offset_of!(sockaddr_un, sun_path) + name.len()) as u32;

        assert!(!is_wayland_socket(
            &sun as *const _ as *const c_void,
            addrlen
        ));

        let (sun, _) = unix_addr(name);
        assert!(!is_wayland_socket(&sun as *const _ as *const c_void, 0));
        assert!(!is_wayland_socket(&sun as *const _ as *const c_void, 1));
    }

    #[test]
    fn socket_detection_follows_the_display_name() {
        // SAFETY: no other test in this binary reads or writes the environment.
        let saved = std::env::var("WAYLAND_DISPLAY").ok();
        unsafe { std::env::remove_var("WAYLAND_DISPLAY") };

        // Without a configured display, the socket filename is inspected.
        assert!(is_wayland_named(b"/run/user/1000/wayland-0"));
        assert!(is_wayland_named(b"/run/user/1000/wayland-12"));
        assert!(is_wayland_named(b"wayland-0"), "relative name");
        assert!(is_wayland_named(b"\0wayland-1"), "abstract socket");
        assert!(!is_wayland_named(b"/run/user/1000/wayland-"));
        assert!(!is_wayland_named(b"/run/user/1000/wayland-abc"));
        assert!(!is_wayland_named(b"/run/user/1000/something-0"));
        assert!(!is_wayland_named(b"/tmp/.X11-unix/X0"));
        assert!(!is_wayland_named(b""));

        // With one, the configured name wins over the filename heuristic.
        unsafe { std::env::set_var("WAYLAND_DISPLAY", "wayland-custom") };
        assert!(is_wayland_named(b"/run/user/1000/wayland-custom"));
        assert!(
            !is_wayland_named(b"/run/user/1000/wayland-0"),
            "the configured display is authoritative"
        );

        match saved {
            Some(value) => unsafe { std::env::set_var("WAYLAND_DISPLAY", value) },
            None => unsafe { std::env::remove_var("WAYLAND_DISPLAY") },
        }
    }
}
