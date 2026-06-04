use std::{
    collections::HashMap,
    mem,
    os::fd::RawFd,
    sync::{Arc, Condvar, Mutex, OnceLock},
    time::Duration,
};

use libc::{AF_UNIX, c_void, sa_family_t, sockaddr, sockaddr_un};

const X11_BUFFER_LIMIT: usize = 4 * 1024 * 1024;

#[derive(PartialEq)]
enum State {
    Setup,
    Connected,
}

#[derive(PartialEq, Clone, Copy)]
enum InjectedType {
    InternAtomNetWmMoveresize,
    QueryExtensionShape,
    QueryPointer,
    Other,
}

struct QueryPointerPending {
    result: Mutex<Option<(i16, i16)>>,
    condvar: Condvar,
}

struct X11Conn {
    real_fd: RawFd,
    server_write_lock: Arc<Mutex<()>>,
    tx_state: State,
    rx_state: State,
    tx_buf: Vec<u8>,
    rx_buf: Vec<u8>,
    tx_stream_remaining: usize,
    rx_stream_remaining: usize,
    rx_stream_drop: bool,
    is_le: bool,
    client_seq: u16,
    server_seq: u16,
    seq_offset: u16,
    offset_transitions: Vec<(u16, u16)>, // (first_wire_seq_affected, offset_to_apply)
    injected_seqs: HashMap<u16, InjectedType>,
    net_wm_moveresize: Option<u32>,
    shape_opcode: Option<u8>,
    root_window: u32,
    root_x: i16,
    root_y: i16,
    button: u8,
    query_pointer_pending: Option<Arc<QueryPointerPending>>,
}

impl X11Conn {
    fn new(real_fd: RawFd) -> Self {
        Self {
            real_fd,
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
            root_window: 0,
            root_x: 0,
            root_y: 0,
            button: 1, // Default to Left Click
            query_pointer_pending: None,
        }
    }
}

fn checked_word_len(words: usize) -> Option<usize> {
    words.checked_mul(4)
}

fn log_parser_close(fd: RawFd, direction: &str, reason: &str, buffered: usize) {
    eprintln!("[proxy:x11] closing {direction} stream for fd {fd}: {reason}; buffered={buffered}");
}

static IS_X11: OnceLock<bool> = OnceLock::new();
static X11_CONNS: OnceLock<Mutex<HashMap<RawFd, X11Conn>>> = OnceLock::new();
static LAST_ACTIVE_FD: OnceLock<Mutex<Option<RawFd>>> = OnceLock::new();

#[inline]
fn r16(b: &[u8], le: bool) -> u16 {
    if le {
        u16::from_le_bytes(b[0..2].try_into().unwrap())
    } else {
        u16::from_be_bytes(b[0..2].try_into().unwrap())
    }
}

#[inline]
fn r32(b: &[u8], le: bool) -> u32 {
    if le {
        u32::from_le_bytes(b[0..4].try_into().unwrap())
    } else {
        u32::from_be_bytes(b[0..4].try_into().unwrap())
    }
}

#[inline]
fn write_u16(b: &mut [u8], v: u16, le: bool) {
    b[0..2].copy_from_slice(&(if le { v.to_le_bytes() } else { v.to_be_bytes() }));
}

#[inline]
fn write_u32(b: &mut [u8], v: u32, le: bool) {
    b[0..4].copy_from_slice(&(if le { v.to_le_bytes() } else { v.to_be_bytes() }));
}

fn record_injected_request(conn: &mut X11Conn, count: u16) {
    conn.server_seq = conn.server_seq.wrapping_add(count);
    conn.seq_offset = conn.seq_offset.wrapping_add(count);
    for i in 0..count {
        conn.injected_seqs
            .insert(conn.server_seq.wrapping_sub(i), InjectedType::Other);
    }

    conn.offset_transitions
        .push((conn.server_seq.wrapping_add(1), conn.seq_offset));
    if conn.offset_transitions.len() > 32 {
        conn.offset_transitions.drain(0..16);
    }
    conn.injected_seqs
        .retain(|&k, _| conn.server_seq.wrapping_sub(k) < 32768);
}

pub(crate) fn server_write_lock(fd: RawFd) -> Option<Arc<Mutex<()>>> {
    let m = X11_CONNS.get()?;
    let map = m.lock().ok()?;
    map.get(&fd).map(|conn| Arc::clone(&conn.server_write_lock))
}

fn update_last_active_fd(fd: RawFd) {
    if let Some(m) = LAST_ACTIVE_FD.get()
        && let Ok(mut opt) = m.lock()
    {
        *opt = Some(fd);
    }
}

pub(crate) fn feed_inbound(fd: RawFd, chunk: &[u8]) -> Option<Vec<u8>> {
    update_last_active_fd(fd);
    let Some(m) = X11_CONNS.get() else {
        return Some(chunk.to_vec());
    };
    let Ok(mut map) = m.lock() else {
        return Some(chunk.to_vec());
    };
    let Some(conn) = map.get_mut(&fd) else {
        return Some(chunk.to_vec());
    };

    let mut out = Vec::new();
    let mut chunk_off = 0;
    if conn.rx_stream_remaining > 0 {
        let n = conn.rx_stream_remaining.min(chunk.len());
        if !conn.rx_stream_drop {
            out.extend_from_slice(&chunk[..n]);
        }
        conn.rx_stream_remaining -= n;
        if conn.rx_stream_remaining == 0 {
            conn.rx_stream_drop = false;
        }
        chunk_off = n;
    }

    if chunk_off == chunk.len() {
        return Some(out);
    }

    conn.rx_buf.extend_from_slice(&chunk[chunk_off..]);

    let mut off = 0;
    while off < conn.rx_buf.len() {
        if conn.rx_state == State::Setup {
            if conn.rx_buf.len() - off < 8 {
                break;
            }
            let status = conn.rx_buf[off];
            let total = if status == 1 || status == 2 {
                8 + (r16(&conn.rx_buf[off + 6..off + 8], conn.is_le) as usize) * 4
            } else {
                8 + ((conn.rx_buf[off + 1] as usize + 3) & !3)
            };
            if conn.rx_buf.len() - off < total {
                break;
            }

            if status == 1 && conn.root_window == 0 && conn.rx_buf.len() - off >= 32 {
                let vendor_len = r16(&conn.rx_buf[off + 24..off + 26], conn.is_le) as usize;
                let num_formats = conn.rx_buf[off + 29] as usize;
                let pad_vendor = (vendor_len + 3) & !3;
                let screen_off = off + 40 + pad_vendor + num_formats * 8;
                if screen_off + 4 <= off + total {
                    conn.root_window = r32(&conn.rx_buf[screen_off..screen_off + 4], conn.is_le);
                }
            }

            conn.rx_state = State::Connected;
            out.extend_from_slice(&conn.rx_buf[off..off + total]);
            off += total;
        } else {
            if conn.rx_buf.len() - off < 32 {
                break;
            }
            let code = conn.rx_buf[off];
            let is_reply_or_error = code == 0 || code == 1;

            let total = match code & 0x7F {
                1 | 35 => {
                    let Some(extra) =
                        checked_word_len(r32(&conn.rx_buf[off + 4..off + 8], conn.is_le) as usize)
                    else {
                        log_parser_close(fd, "inbound", "server message length overflow", 0);
                        return None;
                    };
                    let Some(total) = 32usize.checked_add(extra) else {
                        log_parser_close(fd, "inbound", "server message length overflow", 0);
                        return None;
                    };
                    total
                }
                _ => 32,
            };
            let inspect_len = if code & 0x7F == 35 { total.min(40) } else { 32 };
            if conn.rx_buf.len() - off < inspect_len {
                break;
            }

            let seq = r16(&conn.rx_buf[off + 2..off + 4], conn.is_le);
            let mut drop = false;

            if is_reply_or_error && let Some(inj_type) = conn.injected_seqs.remove(&seq) {
                drop = true;
                if code == 1 {
                    match inj_type {
                        InjectedType::InternAtomNetWmMoveresize => {
                            conn.net_wm_moveresize =
                                Some(r32(&conn.rx_buf[off + 8..off + 12], conn.is_le));
                        }
                        InjectedType::QueryExtensionShape => {
                            let present = conn.rx_buf[off + 8] != 0;
                            if present {
                                conn.shape_opcode = Some(conn.rx_buf[off + 9]);
                            }
                        }
                        InjectedType::QueryPointer => {
                            let root_x = r16(&conn.rx_buf[off + 16..off + 18], conn.is_le) as i16;
                            let root_y = r16(&conn.rx_buf[off + 18..off + 20], conn.is_le) as i16;
                            if let Some(ref pending) = conn.query_pointer_pending
                                && let Ok(mut result) = pending.result.lock()
                            {
                                *result = Some((root_x, root_y));
                                pending.condvar.notify_one();
                            }
                        }
                        _ => {}
                    }
                }
            }

            let available = conn.rx_buf.len() - off;
            let forward_len = available.min(total);
            let out_start = out.len();
            if !drop {
                let evt_code = code & 0x7F;
                out.extend_from_slice(&conn.rx_buf[off..off + forward_len]);

                if evt_code != 11 {
                    // KeymapNotify is unsequenced
                    let mut applied_offset = 0;
                    for &(transition_seq, offset) in &conn.offset_transitions {
                        if seq.wrapping_sub(transition_seq) < 32768 {
                            applied_offset = offset;
                        }
                    }
                    if applied_offset > 0 {
                        let new_seq = seq.wrapping_sub(applied_offset);
                        write_u16(&mut out[out_start + 2..out_start + 4], new_seq, conn.is_le);
                    }
                }

                if evt_code == 4 || evt_code == 5 || evt_code == 6 {
                    conn.root_window = r32(&conn.rx_buf[off + 8..off + 12], conn.is_le);
                    if evt_code == 4 {
                        conn.button = conn.rx_buf[off + 1];
                        conn.root_x = r16(&conn.rx_buf[off + 20..off + 22], conn.is_le) as i16;
                        conn.root_y = r16(&conn.rx_buf[off + 22..off + 24], conn.is_le) as i16;
                    }
                } else if evt_code == 35 && inspect_len >= 40 {
                    let evtype = r16(&conn.rx_buf[off + 8..off + 10], conn.is_le);
                    if evtype == 4 || evtype == 5 || evtype == 6 {
                        conn.root_window = r32(&conn.rx_buf[off + 20..off + 24], conn.is_le);
                        if evtype == 4 {
                            conn.button = r32(&conn.rx_buf[off + 16..off + 20], conn.is_le) as u8;
                            let rx_fp = r32(&conn.rx_buf[off + 32..off + 36], conn.is_le) as i32;
                            let ry_fp = r32(&conn.rx_buf[off + 36..off + 40], conn.is_le) as i32;
                            conn.root_x = (rx_fp >> 16) as i16;
                            conn.root_y = (ry_fp >> 16) as i16;
                        }
                    }
                }
            }

            if forward_len < total {
                conn.rx_stream_remaining = total - forward_len;
                conn.rx_stream_drop = drop;
            }
            off += forward_len;
        }
    }
    conn.rx_buf.drain(..off);
    if conn.rx_buf.len() > X11_BUFFER_LIMIT {
        log_parser_close(
            fd,
            "inbound",
            "buffer exceeded hard limit before a full X11 frame was inspectable",
            conn.rx_buf.len(),
        );
        return None;
    }
    Some(out)
}

pub(crate) fn feed_outbound(fd: RawFd, chunk: &[u8]) -> Option<Vec<u8>> {
    update_last_active_fd(fd);
    let Some(m) = X11_CONNS.get() else {
        return Some(chunk.to_vec());
    };
    let Ok(mut map) = m.lock() else {
        return Some(chunk.to_vec());
    };
    let Some(conn) = map.get_mut(&fd) else {
        return Some(chunk.to_vec());
    };

    let mut out = Vec::new();
    let mut chunk_off = 0;
    if conn.tx_stream_remaining > 0 {
        let n = conn.tx_stream_remaining.min(chunk.len());
        out.extend_from_slice(&chunk[..n]);
        conn.tx_stream_remaining -= n;
        chunk_off = n;
    }

    if chunk_off == chunk.len() {
        return Some(out);
    }

    conn.tx_buf.extend_from_slice(&chunk[chunk_off..]);

    let mut off = 0;
    while off < conn.tx_buf.len() {
        if conn.tx_state == State::Setup {
            if conn.tx_buf.len() - off < 12 {
                break;
            }
            let is_le = conn.tx_buf[off] == b'l';
            let nlen = r16(&conn.tx_buf[off + 6..off + 8], is_le);
            let dlen = r16(&conn.tx_buf[off + 8..off + 10], is_le);
            let total = 12 + ((nlen + 3) & !3) as usize + ((dlen + 3) & !3) as usize;
            if conn.tx_buf.len() - off < total {
                break;
            }

            conn.is_le = is_le;
            conn.tx_state = State::Connected;
            out.extend_from_slice(&conn.tx_buf[off..off + total]);
            off += total;

            let mut req1 = [0u8; 28];
            req1[0] = 16;
            write_u16(&mut req1[2..4], 7, conn.is_le);
            write_u16(&mut req1[4..6], 18, conn.is_le);
            req1[8..26].copy_from_slice(b"_NET_WM_MOVERESIZE");
            conn.server_seq = conn.server_seq.wrapping_add(1);
            conn.seq_offset = conn.seq_offset.wrapping_add(1);
            conn.injected_seqs
                .insert(conn.server_seq, InjectedType::InternAtomNetWmMoveresize);
            out.extend_from_slice(&req1);

            let mut req2 = [0u8; 16];
            req2[0] = 98; // QueryExtension
            write_u16(&mut req2[2..4], 4, conn.is_le);
            write_u16(&mut req2[4..6], 5, conn.is_le);
            req2[8..13].copy_from_slice(b"SHAPE");
            conn.server_seq = conn.server_seq.wrapping_add(1);
            conn.seq_offset = conn.seq_offset.wrapping_add(1);
            conn.injected_seqs
                .insert(conn.server_seq, InjectedType::QueryExtensionShape);
            out.extend_from_slice(&req2);

            conn.offset_transitions
                .push((conn.server_seq.wrapping_add(1), conn.seq_offset));
        } else {
            if conn.tx_buf.len() - off < 4 {
                break;
            }
            let mut words = r16(&conn.tx_buf[off + 2..off + 4], conn.is_le) as usize;
            let mut hdr = 4;
            if words == 0 {
                if conn.tx_buf.len() - off < 8 {
                    break;
                }
                words = r32(&conn.tx_buf[off + 4..off + 8], conn.is_le) as usize;
                hdr = 8;
            }
            let Some(total) = checked_word_len(words) else {
                log_parser_close(fd, "outbound", "client request length overflow", 0);
                return None;
            };
            if total < hdr {
                log_parser_close(
                    fd,
                    "outbound",
                    "client request length is shorter than its header",
                    conn.tx_buf.len() - off,
                );
                return None;
            }
            if conn.tx_buf.len() - off < total && total <= X11_BUFFER_LIMIT {
                break;
            }

            conn.client_seq = conn.client_seq.wrapping_add(1);
            conn.server_seq = conn.server_seq.wrapping_add(1);
            let available = conn.tx_buf.len() - off;
            let forward_len = available.min(total);
            out.extend_from_slice(&conn.tx_buf[off..off + forward_len]);
            if forward_len < total {
                conn.tx_stream_remaining = total - forward_len;
            }
            off += forward_len;
        }
    }

    conn.tx_buf.drain(..off);
    if conn.tx_buf.len() > X11_BUFFER_LIMIT {
        log_parser_close(
            fd,
            "outbound",
            "buffer exceeded hard limit before a full X11 frame was inspectable",
            conn.tx_buf.len(),
        );
        return None;
    }
    Some(out)
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

pub(crate) fn on_new_connection(fd: RawFd, real_fd: RawFd) {
    update_last_active_fd(fd);
    IS_X11.set(true).ok();
    if let Some(m) = X11_CONNS.get()
        && let Ok(mut map) = m.lock()
    {
        map.insert(fd, X11Conn::new(real_fd));
    }
}

pub(crate) fn on_close(fd: RawFd) {
    if let Some(m) = X11_CONNS.get()
        && let Ok(mut map) = m.lock()
    {
        map.remove(&fd);
    }
    if let Some(m) = LAST_ACTIVE_FD.get()
        && let Ok(mut opt) = m.lock()
        && opt.is_some_and(|f| f == fd)
    {
        *opt = None;
    }
}

pub(super) fn is_x11() -> bool {
    *IS_X11.get().unwrap_or(&false)
}

pub(super) fn send_net_wm_moveresize_move(window: u32) -> bool {
    let fd = {
        let Some(m) = LAST_ACTIVE_FD.get() else {
            return false;
        };
        let Ok(opt) = m.lock() else {
            return false;
        };
        let Some(fd) = *opt else {
            return false;
        };
        fd
    };

    let Some(write_lock) = server_write_lock(fd) else {
        return false;
    };
    let Ok(_write_guard) = write_lock.lock() else {
        return false;
    };

    let (real_fd, root, atom, root_x, root_y, button, is_le) = {
        let Some(m) = X11_CONNS.get() else {
            return false;
        };
        let Ok(mut map) = m.lock() else {
            return false;
        };
        let Some(conn) = map.get_mut(&fd) else {
            return false;
        };

        let Some(atom) = conn.net_wm_moveresize else {
            return false;
        };
        if conn.root_window == 0 {
            return false;
        }

        record_injected_request(conn, 2);

        (
            conn.real_fd,
            conn.root_window,
            atom,
            conn.root_x,
            conn.root_y,
            conn.button,
            conn.is_le,
        )
    };

    let mut payload = [0u8; 52];
    payload[0] = 27;
    write_u16(&mut payload[2..4], 2, is_le);
    write_u32(&mut payload[4..8], 0, is_le);

    payload[8] = 25;
    payload[9] = 0;
    write_u16(&mut payload[10..12], 11, is_le);
    write_u32(&mut payload[12..16], root, is_le);
    write_u32(&mut payload[16..20], 0x180000, is_le);

    payload[20] = 33;
    payload[21] = 32;
    write_u16(&mut payload[22..24], 0, is_le);
    write_u32(&mut payload[24..28], window, is_le);
    write_u32(&mut payload[28..32], atom, is_le);
    write_u32(&mut payload[32..36], root_x as u32, is_le);
    write_u32(&mut payload[36..40], root_y as u32, is_le);
    write_u32(&mut payload[40..44], 8, is_le);
    write_u32(&mut payload[44..48], button as u32, is_le);
    write_u32(&mut payload[48..52], 1, is_le);

    super::hook::send_raw_msg(real_fd, &payload)
}

pub(super) fn set_input_region_rects(window: u32, rects: Option<&[super::Rect]>) -> bool {
    let fd = {
        let Some(m) = LAST_ACTIVE_FD.get() else {
            return false;
        };
        let Ok(opt) = m.lock() else {
            return false;
        };
        let Some(fd) = *opt else {
            return false;
        };
        fd
    };

    let Some(write_lock) = server_write_lock(fd) else {
        return false;
    };
    let Ok(_write_guard) = write_lock.lock() else {
        return false;
    };

    let (real_fd, shape_opcode, is_le) = {
        let Some(m) = X11_CONNS.get() else {
            return false;
        };
        let Ok(mut map) = m.lock() else {
            return false;
        };
        let Some(conn) = map.get_mut(&fd) else {
            return false;
        };

        let Some(shape_opcode) = conn.shape_opcode else {
            return false;
        };

        record_injected_request(conn, 1);

        (conn.real_fd, shape_opcode, conn.is_le)
    };

    if let Some(rects) = rects {
        let num_rects = rects.len();
        let length = 4 + num_rects * 2;
        let mut payload = vec![0u8; length * 4];

        payload[0] = shape_opcode;
        payload[1] = 1; // ShapeRectangles
        write_u16(&mut payload[2..4], length as u16, is_le);
        payload[4] = 0; // operation = ShapeSet
        payload[5] = 2; // destination_kind = ShapeInput
        payload[6] = 0; // ordering = UnSorted
        payload[7] = 0; // pad
        write_u32(&mut payload[8..12], window, is_le);
        write_u16(&mut payload[12..14], 0, is_le); // x_offset
        write_u16(&mut payload[14..16], 0, is_le); // y_offset

        for (i, r) in rects.iter().enumerate() {
            let off = 16 + i * 8;
            write_u16(&mut payload[off..off + 2], r.x as u16, is_le);
            write_u16(&mut payload[off + 2..off + 4], r.y as u16, is_le);
            write_u16(&mut payload[off + 4..off + 6], r.w as u16, is_le);
            write_u16(&mut payload[off + 6..off + 8], r.h as u16, is_le);
        }
        super::hook::send_raw_msg(real_fd, &payload)
    } else {
        let mut payload = [0u8; 20];

        payload[0] = shape_opcode;
        payload[1] = 2; // ShapeMask
        write_u16(&mut payload[2..4], 5, is_le); // length: 5 words = 20 bytes
        payload[4] = 0; // operation = ShapeSet
        payload[5] = 2; // destination_kind = ShapeInput
        payload[6] = 0; // pad
        payload[7] = 0; // pad
        write_u32(&mut payload[8..12], window, is_le);
        write_u16(&mut payload[12..14], 0, is_le); // x_offset
        write_u16(&mut payload[14..16], 0, is_le); // y_offset
        write_u32(&mut payload[16..20], 0, is_le); // source_bitmap = None (0) defaults region reset

        super::hook::send_raw_msg(real_fd, &payload)
    }
}

pub(super) fn query_pointer(window: u32) -> Option<(i16, i16)> {
    let fd = {
        let m = LAST_ACTIVE_FD.get()?;
        let opt = m.lock().ok()?;
        (*opt)?
    };

    let write_lock = server_write_lock(fd)?;
    let write_guard = write_lock.lock().ok()?;

    let pending = Arc::new(QueryPointerPending {
        result: Mutex::new(None),
        condvar: Condvar::new(),
    });

    let (real_fd, is_le, window) = {
        let m = X11_CONNS.get()?;
        let mut map = m.lock().ok()?;
        let conn = map.get_mut(&fd)?;

        conn.query_pointer_pending = Some(Arc::clone(&pending));

        // If window is 0, fall back to the tracked root window
        let effective_window = if window == 0 {
            if conn.root_window == 0 {
                return None;
            }
            conn.root_window
        } else {
            window
        };

        // Manually track the injected QueryPointer request sequence
        conn.server_seq = conn.server_seq.wrapping_add(1);
        conn.seq_offset = conn.seq_offset.wrapping_add(1);
        conn.injected_seqs
            .insert(conn.server_seq, InjectedType::QueryPointer);
        conn.offset_transitions
            .push((conn.server_seq.wrapping_add(1), conn.seq_offset));
        if conn.offset_transitions.len() > 32 {
            conn.offset_transitions.drain(0..16);
        }
        conn.injected_seqs
            .retain(|&k, _| conn.server_seq.wrapping_sub(k) < 32768);

        (conn.real_fd, conn.is_le, effective_window)
    };

    let mut payload = [0u8; 8];
    payload[0] = 38; // QueryPointer opcode
    write_u16(&mut payload[2..4], 2, is_le); // length = 2 words
    write_u32(&mut payload[4..8], window, is_le);

    if !super::hook::send_raw_msg(real_fd, &payload) {
        // Roll back sequence tracking and pending state on send failure
        if let Some(m) = X11_CONNS.get()
            && let Ok(mut map) = m.lock()
            && let Some(conn) = map.get_mut(&fd)
        {
            conn.query_pointer_pending = None;
            conn.injected_seqs.remove(&conn.server_seq);
            conn.offset_transitions.pop();
            conn.server_seq = conn.server_seq.wrapping_sub(1);
            conn.seq_offset = conn.seq_offset.wrapping_sub(1);
        }
        return None;
    }
    // Release write lock before waiting — inbound processing in forward_msg
    // does not require the write lock, so the proxy loop can still deliver
    // the reply while we wait.
    drop(write_guard);

    // Wait for the reply to arrive via feed_inbound
    let result = {
        let mut result_guard = pending.result.lock().ok()?;
        while result_guard.is_none() {
            let (guard, timeout_result) = pending
                .condvar
                .wait_timeout(result_guard, Duration::from_millis(500))
                .ok()?;
            result_guard = guard;
            if timeout_result.timed_out() {
                // Drop result_guard before acquiring X11_CONNS to avoid
                // deadlock: feed_inbound locks X11_CONNS → pending.result,
                // so we must not hold pending.result while locking X11_CONNS.
                drop(result_guard);
                if let Some(m) = X11_CONNS.get()
                    && let Ok(mut map) = m.lock()
                    && let Some(conn) = map.get_mut(&fd)
                {
                    conn.query_pointer_pending = None;
                }
                return None;
            }
        }
        *result_guard
    };

    // Clean up
    if let Some(m) = X11_CONNS.get()
        && let Ok(mut map) = m.lock()
        && let Some(conn) = map.get_mut(&fd)
    {
        conn.query_pointer_pending = None;
    }

    result
}

pub(crate) fn init_state() {
    X11_CONNS.get_or_init(|| Mutex::new(HashMap::new()));
    LAST_ACTIVE_FD.get_or_init(|| Mutex::new(None));
}

pub(crate) fn clear_state() {
    if let Some(m) = X11_CONNS.get()
        && let Ok(mut map) = m.lock()
    {
        map.clear();
    }
    if let Some(m) = LAST_ACTIVE_FD.get()
        && let Ok(mut opt) = m.lock()
    {
        *opt = None;
    }
}
