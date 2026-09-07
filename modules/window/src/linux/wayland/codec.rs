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
    WlSurface,
    XdgWmBase,
    XdgPositioner,
    XdgSurface,
    XdgToplevel,
    /// An xdg_popup presented to Chromium as if it were an xdg_toplevel.
    XdgPopupShim,
}

// ── Message opcodes ────────────────────────────────────────────────────────

pub(crate) const EVT_DELETE_ID: u16 = 1;
pub(crate) const REQ_GET_REGISTRY: u16 = 1;
pub(crate) const REQ_BIND: u16 = 0;
pub(crate) const REQ_CREATE_SURFACE: u16 = 0;
pub(crate) const REQ_CREATE_REGION: u16 = 1;
pub(crate) const REQ_GET_POINTER: u16 = 0;
pub(crate) const EVT_ENTER: u16 = 0;
pub(crate) const EVT_LEAVE: u16 = 1;
pub(crate) const EVT_BUTTON: u16 = 3;
pub(crate) const EVT_AXIS: u16 = 4;
pub(crate) const EVT_MOTION: u16 = 2;
pub(crate) const BTN_PRESSED: u32 = 1;
pub(crate) const REQ_GET_XDG_SURFACE: u16 = 2;
pub(crate) const REQ_GET_TOPLEVEL: u16 = 1;
pub(crate) const REQ_CREATE_POSITIONER: u16 = 1;
pub(crate) const REQ_GET_POPUP: u16 = 2;
pub(crate) const REQ_SET_TITLE: u16 = 2;
pub(crate) const REQ_MOVE: u16 = 5;
pub(crate) const REQ_SET_INPUT_REGION: u16 = 5;
pub(crate) const WL_POINTER_RELEASE: u16 = 1;
pub(crate) const REQ_DESTROY: u16 = 0;
pub(crate) const REQ_REGION_DESTROY: u16 = 0;
pub(crate) const REQ_REGION_ADD: u16 = 1;

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
