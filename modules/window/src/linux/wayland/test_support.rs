//! Wire-format helpers and fixtures shared by the Wayland test modules.
//!
//! Every module that drives the pipeline needs to encode Wayland messages and
//! inspect the ones production emitted, and the modules that touch the
//! process-global policy map need the same connection and the same lock. Until
//! now each carried its own copy — which is how the same size-field bug had to
//! be fixed twice. Both live here, named by what they are for, so the wire
//! format and the fixtures are written down once.

use std::{
    io::Read,
    os::fd::{AsRawFd, RawFd},
    os::unix::net::UnixStream,
    sync::{Arc, Mutex, MutexGuard},
};

use crate::linux::proxy::{SINKS, Sink};

use super::codec::{Iface, WlMessage};
use super::handlers::Action;
use super::layer_shell::{
    ANCHOR_BOTTOM, ANCHOR_LEFT, ANCHOR_RIGHT, ANCHOR_TOP, LAYER_OVERLAY, LayerShellOptions,
};
use super::state::{CONNS, WaylandConn};

/// Round `len` up to the next multiple of 4, the Wayland word size.
pub(crate) fn padded_len(len: usize) -> usize {
    len.next_multiple_of(4)
}

/// An 8-byte header whose size field claims `size` **bytes**.
///
/// Bytes, not 4-byte units: that is X11's convention, not Wayland's.
pub(crate) fn header_bytes(object_id: u32, opcode: u16, size: usize) -> [u8; 8] {
    let mut buf = [0u8; 8];
    buf[..4].copy_from_slice(&object_id.to_ne_bytes());
    buf[4..].copy_from_slice(&(((size as u32) << 16) | opcode as u32).to_ne_bytes());
    buf
}

/// A complete message: header plus `args`, padded to a 4-byte boundary.
pub(crate) fn message_bytes(object_id: u32, opcode: u16, args: &[u8]) -> Vec<u8> {
    // The header describes the *padded* length, so the body has to be padded
    // before the header can be written.
    let len = padded_len(8 + args.len());
    let mut buf = Vec::with_capacity(len);
    buf.extend_from_slice(&header_bytes(object_id, opcode, len));
    buf.extend_from_slice(args);
    buf.resize(len, 0);
    buf
}

/// [`message_bytes`] as the decoder would hand it to a handler.
pub(crate) fn message(object_id: u32, opcode: u16, args: &[u8]) -> WlMessage {
    WlMessage::new(object_id, opcode, message_bytes(object_id, opcode, args))
}

/// A message whose header claims `size` bytes and whose buffer is exactly that
/// long — including sizes no real message may use, which is the point.
pub(crate) fn declared_message(object_id: u32, opcode: u16, size: usize) -> Vec<u8> {
    let mut buf = header_bytes(object_id, opcode, size).to_vec();
    buf.resize(size, 0);
    buf
}

/// A `size`-byte message with word arguments, for asserting the exact bytes an
/// injection wrote. The caller states the size, so it can express the
/// expectation before the code under test reads the header.
pub(crate) fn request(object_id: u32, opcode: u16, size: usize, args: &[u32]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(size);
    buf.extend_from_slice(&header_bytes(object_id, opcode, size));
    for arg in args {
        buf.extend_from_slice(&arg.to_ne_bytes());
    }
    buf
}

/// A 32-bit argument.
pub(crate) fn word(value: u32) -> Vec<u8> {
    value.to_ne_bytes().to_vec()
}

/// A wire-format string: its length *including* the NUL terminator, the bytes,
/// the terminator, then zero padding.
pub(crate) fn wl_string(text: &str) -> Vec<u8> {
    let mut body = text.as_bytes().to_vec();
    body.push(0);

    let mut buf = word(body.len() as u32);
    buf.extend_from_slice(&body);
    buf.resize(padded_len(buf.len()), 0);
    buf
}

// ── Message inspection ─────────────────────────────────────────────────────

/// Decode a complete message's header as `(object_id, opcode, size)`.
///
/// [`header_bytes`] writes the header; this is the read side the tests use to
/// check what production emitted without hard-coding offsets.
pub(crate) fn header(buf: &[u8]) -> (u32, u16, usize) {
    let packed = u32::from_ne_bytes(buf[4..8].try_into().unwrap());
    (
        u32::from_ne_bytes(buf[0..4].try_into().unwrap()),
        (packed & 0xFFFF) as u16,
        (packed >> 16) as usize,
    )
}

/// The 32-bit argument at `offset` in a message body.
pub(crate) fn u32_at(buf: &[u8], offset: usize) -> u32 {
    u32::from_ne_bytes(buf[offset..offset + 4].try_into().unwrap())
}

/// The messages an [`Action::Replace`] carries, panicking for any other action.
pub(crate) fn replaced(action: Action) -> Vec<Vec<u8>> {
    match action {
        Action::Replace(messages) => messages,
        _ => panic!("expected a replacement"),
    }
}

// ── Shared fixtures ────────────────────────────────────────────────────────
//
// The policy map, the popup reservations and the connection registry are all
// process-global, so every module that touches them has to build the same
// connection and serialize against the others.

/// The canonical test options: an overlay covering the whole output.
pub(crate) fn options() -> LayerShellOptions {
    LayerShellOptions {
        namespace: "open-orpheus-test".into(),
        layer: LAYER_OVERLAY,
        anchor: ANCHOR_TOP | ANCHOR_BOTTOM | ANCHOR_LEFT | ANCHOR_RIGHT,
        ..Default::default()
    }
}

/// A connection that has seen a compositor, an xdg_surface and one spare id.
pub(crate) fn connected() -> WaylandConn {
    let mut conn = WaylandConn::new();
    conn.registry_id = Some(5);
    conn.ifaces.insert(5, Iface::WlRegistry);
    conn.layer_shell_global = Some((63, 5));
    conn.ifaces.insert(10, Iface::WlSurface);
    conn.ifaces.insert(20, Iface::XdgSurface);
    conn.xdg_to_wl.insert(20, 10);
    conn.stolen_ids.push(50);
    conn
}

/// A connection with a compositor on the other end of it.
///
/// Synthesised requests are written straight to the server fd of a sink, so a
/// fixture that only registers a connection has nothing to write to and every
/// sending call is refused rather than merely unobservable. The observer end is
/// where those bytes can be read back.
pub(crate) struct AttachedSink {
    /// Holds the fd the writes go to open for as long as the fixture lives.
    _server: UnixStream,
    /// The far end, which is where a synthesised request shows up.
    observer: UnixStream,
}

impl AttachedSink {
    pub(crate) fn new(fd: RawFd) -> Self {
        let (server, observer) = UnixStream::pair().expect("socketpair");
        SINKS.get_or_init(Default::default).lock().unwrap().insert(
            fd,
            Sink {
                real_fd: server.as_raw_fd(),
                app_fd: fd,
                write_lock: Some(Arc::new(Mutex::new(()))),
            },
        );
        Self {
            _server: server,
            observer,
        }
    }

    /// Everything written since the last read, or nothing yet.
    pub(crate) fn written(&mut self) -> Vec<u8> {
        self.observer.set_nonblocking(true).expect("nonblocking");
        let mut sent = Vec::new();
        let mut buf = [0u8; 256];
        while let Ok(read) = self.observer.read(&mut buf) {
            if read == 0 {
                break;
            }
            sent.extend_from_slice(&buf[..read]);
        }
        sent
    }
}

/// One test mutex for every module that touches the process-global state.
///
/// It is deliberately poison-tolerant: a failure in one case must not turn
/// every later case into a `PoisonError`.
pub(crate) static SERIAL: Mutex<()> = Mutex::new(());

/// [`SERIAL`] as the guard the fixtures hand out.
pub(crate) fn serial() -> MutexGuard<'static, ()> {
    SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// [`serial`] plus a fresh state and no layer policies.
pub(crate) fn fixture() -> (MutexGuard<'static, ()>, WaylandConn) {
    let guard = serial();
    super::state::init_state();
    super::state::clear_all_layer_policies();
    (guard, connected())
}

/// A connection registered in the process-wide map, the way production
/// registers one, so availability can be derived from it.
pub(crate) struct Registered(RawFd);

impl Registered {
    pub(crate) fn new(fd: RawFd, conn: WaylandConn) -> Self {
        CONNS
            .get()
            .expect("initialised")
            .lock()
            .unwrap()
            .insert(fd, conn);
        Self(fd)
    }

    pub(crate) fn with<T>(&self, edit: impl FnOnce(&mut WaylandConn) -> T) -> T {
        let conns = CONNS.get().expect("initialised");
        let mut map = conns.lock().unwrap();
        edit(map.get_mut(&self.0).expect("registered"))
    }
}

impl Drop for Registered {
    fn drop(&mut self) {
        if let Some(conns) = CONNS.get()
            && let Ok(mut map) = conns.lock()
        {
            map.remove(&self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_message_is_padded_and_described_by_its_padded_length() {
        let padded = message_bytes(3, 1, &[1, 2, 3]);

        assert_eq!(padded.len(), 12, "8 + 3 rounds up to 12");
        assert_eq!(padded[11], 0, "the tail is zero padding");
        assert_eq!(
            u16::from_ne_bytes([padded[6], padded[7]]),
            12,
            "the size field counts the padded length in bytes"
        );
    }

    #[test]
    fn a_string_length_counts_its_nul_terminator() {
        let aligned = wl_string("wlp");
        assert_eq!(
            u32::from_ne_bytes(aligned[..4].try_into().expect("4 bytes")),
            4,
            "3 characters plus the terminator"
        );
        assert_eq!(aligned.len(), 8, "4 + 3 + 1 already ends on a word");

        let padded = wl_string("wl");
        assert_eq!(
            u32::from_ne_bytes(padded[..4].try_into().expect("4 bytes")),
            3,
            "2 characters plus the terminator"
        );
        assert_eq!(padded.len(), 8, "4 + 2 + 1 rounds up to 8");
        assert_eq!(padded[7], 0, "the padding is zeroed");
    }
}
