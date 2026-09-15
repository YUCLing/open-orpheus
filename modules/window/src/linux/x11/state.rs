use std::{
    collections::HashMap,
    os::fd::RawFd,
    sync::{Arc, Condvar, Mutex, OnceLock},
};

pub(crate) const X11_BUFFER_LIMIT: usize = 4 * 1024 * 1024;

#[derive(PartialEq, Debug)]
pub(crate) enum State {
    Setup,
    Connected,
}

#[derive(PartialEq, Clone, Copy, Debug)]
pub(crate) enum InjectedType {
    InternAtomNetWmMoveresize,
    QueryExtensionShape,
    QueryExtensionXInput,
    QueryPointer,
    Other,
}

/// The most recently captured press gesture (button press or touch begin).
#[derive(PartialEq, Clone, Copy, Debug)]
pub(crate) enum GestureKind {
    Button,
    TouchBegin,
}

pub(crate) struct QueryPointerPending {
    pub(crate) result: Mutex<Option<(i16, i16)>>,
    pub(crate) condvar: Condvar,
}

pub(crate) struct X11Conn {
    pub(crate) server_write_lock: Arc<Mutex<()>>,
    pub(crate) tx_state: State,
    pub(crate) rx_state: State,
    pub(crate) tx_buf: Vec<u8>,
    pub(crate) rx_buf: Vec<u8>,
    pub(crate) tx_stream_remaining: usize,
    pub(crate) rx_stream_remaining: usize,
    pub(crate) rx_stream_drop: bool,
    pub(crate) is_le: bool,
    pub(crate) client_seq: u16,
    pub(crate) server_seq: u16,
    pub(crate) seq_offset: u16,
    pub(crate) offset_transitions: Vec<(u16, u16)>, // (first_wire_seq_affected, offset_to_apply)
    pub(crate) injected_seqs: HashMap<u16, InjectedType>,
    pub(crate) net_wm_moveresize: Option<u32>,
    pub(crate) shape_opcode: Option<u8>,
    pub(crate) xi_opcode: Option<u8>,
    pub(crate) root_window: u32,
    pub(crate) root_x: i16,
    pub(crate) root_y: i16,
    pub(crate) button: u8,
    pub(crate) query_pointer_pending: Option<Arc<QueryPointerPending>>,
    pub(crate) last_button_press: Option<Vec<u8>>,
    pub(crate) press_accum: Vec<u8>,
    pub(crate) press_remaining: usize,
    pub(crate) last_touch_begin: Option<Vec<u8>>,
    pub(crate) touch_accum: Vec<u8>,
    pub(crate) touch_remaining: usize,
    pub(crate) last_gesture: Option<GestureKind>,
    pub(crate) pending_inbound: Vec<u8>,
    // Ancillary data (SCM_RIGHTS) received with bytes that were buffered and
    // have not been forwarded yet. Attached to the first byte the transport
    // received them with, so they are held here until that byte is forwarded.
    pub(crate) rx_ctrl_bytes: Vec<u8>,
    pub(crate) rx_ctrl_fds: Vec<RawFd>,
    pub(crate) tx_ctrl_bytes: Vec<u8>,
    pub(crate) tx_ctrl_fds: Vec<RawFd>,
}

impl X11Conn {
    pub(crate) fn new() -> Self {
        Self {
            server_write_lock: Arc::new(Mutex::new(())),
            tx_state: State::Setup,
            rx_state: State::Setup,
            tx_buf: Vec::new(),
            rx_buf: Vec::new(),
            tx_stream_remaining: 0,
            rx_stream_remaining: 0,
            rx_stream_drop: false,
            is_le: true,
            client_seq: 0,
            server_seq: 0,
            seq_offset: 0,
            offset_transitions: vec![(0, 0)],
            injected_seqs: HashMap::new(),
            net_wm_moveresize: None,
            shape_opcode: None,
            xi_opcode: None,
            root_window: 0,
            root_x: 0,
            root_y: 0,
            button: 1, // Default to Left Click
            query_pointer_pending: None,
            last_button_press: None,
            press_accum: Vec::new(),
            press_remaining: 0,
            last_touch_begin: None,
            touch_accum: Vec::new(),
            touch_remaining: 0,
            last_gesture: None,
            pending_inbound: Vec::new(),
            rx_ctrl_bytes: Vec::new(),
            rx_ctrl_fds: Vec::new(),
            tx_ctrl_bytes: Vec::new(),
            tx_ctrl_fds: Vec::new(),
        }
    }

    /// Record `count` requests injected directly to the server.
    ///
    /// Byte-for-byte successor of the old `record_injected_request`: the offset
    /// must take effect starting at the FIRST injected request's server
    /// sequence (not the request after the injected range), or injected
    /// requests that emit events (Enter/LeaveNotify, ClientMessage echo,
    /// ShapeNotify, ...) would be rewritten with a too-small offset, producing
    /// a client-visible sequence greater than the client's own counter and
    /// aborting libX11's `poll_for_event`.
    pub(crate) fn begin_injected_requests(&mut self, count: u16) {
        self.server_seq = self.server_seq.wrapping_add(count);
        self.seq_offset = self.seq_offset.wrapping_add(count);
        for i in 0..count {
            self.injected_seqs
                .insert(self.server_seq.wrapping_sub(i), InjectedType::Other);
        }

        let first_injected_seq = self.server_seq.wrapping_sub(count - 1);
        self.offset_transitions
            .push((first_injected_seq, self.seq_offset));
        if self.offset_transitions.len() > 32 {
            self.offset_transitions.drain(0..16);
        }
        self.injected_seqs
            .retain(|&k, _| self.server_seq.wrapping_sub(k) < 32768);
    }
}

pub(crate) static IS_X11: OnceLock<bool> = OnceLock::new();
pub(crate) static X11_CONNS: OnceLock<Mutex<HashMap<RawFd, X11Conn>>> = OnceLock::new();
pub(crate) static LAST_ACTIVE_FD: OnceLock<Mutex<Option<RawFd>>> = OnceLock::new();

pub(crate) fn server_write_lock(fd: RawFd) -> Option<Arc<Mutex<()>>> {
    let m = X11_CONNS.get()?;
    let map = m.lock().ok()?;
    map.get(&fd).map(|conn| Arc::clone(&conn.server_write_lock))
}

/// Close descriptors received via `SCM_RIGHTS` that must not be forwarded
/// (their message was suppressed or the stream desynced).
pub(crate) fn close_ctrl_fds(fds: Vec<RawFd>) {
    for fd in fds {
        if fd >= 0 {
            super::super::proxy::syscalls::call_close(fd);
        }
    }
}

pub(crate) fn update_last_active_fd(fd: RawFd) {
    if let Some(m) = LAST_ACTIVE_FD.get()
        && let Ok(mut opt) = m.lock()
    {
        *opt = Some(fd);
    }
}

pub(crate) fn last_active_fd() -> Option<RawFd> {
    let m = LAST_ACTIVE_FD.get()?;
    *m.lock().ok()?
}

pub(crate) fn is_x11() -> bool {
    *IS_X11.get().unwrap_or(&false)
}

pub(crate) fn on_close(fd: RawFd) {
    if let Some(m) = X11_CONNS.get()
        && let Ok(mut map) = m.lock()
        && let Some(conn) = map.remove(&fd)
    {
        close_ctrl_fds(conn.rx_ctrl_fds);
        close_ctrl_fds(conn.tx_ctrl_fds);
    }
    if let Some(m) = LAST_ACTIVE_FD.get()
        && let Ok(mut opt) = m.lock()
        && opt.is_some_and(|f| f == fd)
    {
        *opt = None;
    }
}

pub(crate) fn init_state() {
    X11_CONNS.get_or_init(|| Mutex::new(HashMap::new()));
    LAST_ACTIVE_FD.get_or_init(|| Mutex::new(None));
}

pub(crate) fn clear_state() {
    if let Some(m) = X11_CONNS.get()
        && let Ok(mut map) = m.lock()
    {
        for (_, conn) in map.drain() {
            close_ctrl_fds(conn.rx_ctrl_fds);
            close_ctrl_fds(conn.tx_ctrl_fds);
        }
    }
    if let Some(m) = LAST_ACTIVE_FD.get()
        && let Ok(mut opt) = m.lock()
    {
        *opt = None;
    }
}

/// Serialises every test that touches the registries above.
///
/// `X11_CONNS`, `SINKS` and `LAST_ACTIVE_FD` live for the whole process, and
/// `filter::feed_inbound` / `feed_outbound` rewrite `LAST_ACTIVE_FD` on every
/// call. A lock private to one test module is therefore not enough: a test in
/// another module can still overwrite the "last active" connection underneath
/// it, which makes the injector target the wrong descriptor (or none at all).
#[cfg(test)]
pub(crate) fn lock_globals() -> std::sync::MutexGuard<'static, ()> {
    static GLOBAL_STATE: Mutex<()> = Mutex::new(());

    GLOBAL_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
