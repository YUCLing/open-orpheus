use std::os::fd::RawFd;

use super::super::proxy::{Cmsg, Filtered};
use super::codec::*;
use super::handlers;
use super::state::*;

/// Disposition of the message carrying the first byte of the current chunk —
/// the byte any `SCM_RIGHTS` control data is attached to.
#[derive(Clone, Copy, PartialEq, Eq)]
enum HeadDisp {
    /// The byte (and its message) is forwarded.
    Forwarded,
    /// The message was suppressed.
    Dropped,
    /// The message is still incomplete and buffered.
    Buffered,
}

fn split_cmsg(cmsg: Option<Cmsg>) -> (Vec<u8>, Vec<RawFd>) {
    match cmsg {
        Some(Cmsg { bytes, fds }) => (bytes, fds),
        None => (Vec::new(), Vec::new()),
    }
}

fn passthrough(chunk: &[u8], cmsg_bytes: Vec<u8>, cmsg_fds: Vec<RawFd>) -> Filtered {
    Filtered {
        data: chunk.to_vec(),
        cmsg: cmsg_bytes,
        fds_to_close: cmsg_fds,
    }
}

/// Merge this chunk's control data into the direction's pending slot and
/// produce the transport result.
///
/// - `Forwarded`: attach all pending control data to the forwarded bytes and
///   close our copies of the descriptors (the transport's `sendmsg` hands
///   them to the peer).
/// - `Dropped`: the message carrying the control data was suppressed — close
///   every descriptor received for it.
/// - `Buffered`: the message is incomplete — keep the control data pending
///   until its bytes are actually forwarded.
fn assemble(
    pending_bytes: &mut Vec<u8>,
    pending_fds: &mut Vec<RawFd>,
    head: HeadDisp,
    out: Vec<u8>,
    new_bytes: Vec<u8>,
    new_fds: Vec<RawFd>,
) -> Filtered {
    if head == HeadDisp::Dropped {
        // The message carrying these descriptors was suppressed: drop its
        // control data and close both the freshly received and deferred
        // descriptors (they belong to the same dropped message).
        let mut stale = std::mem::take(pending_fds);
        stale.extend(new_fds);
        close_ctrl_fds(stale);
        pending_bytes.clear();
    } else {
        pending_bytes.extend(new_bytes);
        pending_fds.extend(new_fds);
    }

    if head != HeadDisp::Forwarded {
        // The chunk head is still buffered: keep the control data pending
        // until its message's bytes are actually forwarded. Forward `out`
        // (which can only contain injected bytes at this point) without
        // attaching any descriptors to it.
        return Filtered {
            data: out,
            cmsg: Vec::new(),
            fds_to_close: Vec::new(),
        };
    }

    Filtered {
        data: out,
        cmsg: std::mem::take(pending_bytes),
        fds_to_close: std::mem::take(pending_fds),
    }
}

pub(crate) fn feed_inbound(fd: RawFd, chunk: &[u8], cmsg: Option<Cmsg>) -> Option<Filtered> {
    update_last_active_fd(fd);
    let (new_bytes, new_fds) = split_cmsg(cmsg);
    let Some(m) = X11_CONNS.get() else {
        return Some(passthrough(chunk, new_bytes, new_fds));
    };
    let Ok(mut map) = m.lock() else {
        return Some(passthrough(chunk, new_bytes, new_fds));
    };
    let Some(conn) = map.get_mut(&fd) else {
        return Some(passthrough(chunk, new_bytes, new_fds));
    };

    let mut out = Vec::new();
    if !conn.pending_inbound.is_empty() {
        out.append(&mut conn.pending_inbound);
    }
    let mut head = HeadDisp::Forwarded;
    let mut chunk_off = 0;
    if conn.rx_stream_remaining > 0 {
        if conn.rx_stream_drop {
            head = HeadDisp::Dropped;
        }
        let n = conn.rx_stream_remaining.min(chunk.len());
        if !conn.rx_stream_drop {
            out.extend_from_slice(&chunk[..n]);
        }
        if conn.press_remaining > 0 {
            let p_n = conn.press_remaining.min(n);
            conn.press_accum.extend_from_slice(&chunk[..p_n]);
            conn.press_remaining -= p_n;
            if conn.press_remaining == 0 {
                conn.last_button_press = Some(std::mem::take(&mut conn.press_accum));
                conn.last_gesture = Some(GestureKind::Button);
            }
        }
        if conn.touch_remaining > 0 {
            let p_n = conn.touch_remaining.min(n);
            conn.touch_accum.extend_from_slice(&chunk[..p_n]);
            conn.touch_remaining -= p_n;
            if conn.touch_remaining == 0 {
                conn.last_touch_begin = Some(std::mem::take(&mut conn.touch_accum));
                conn.last_gesture = Some(GestureKind::TouchBegin);
            }
        }
        conn.rx_stream_remaining -= n;
        if conn.rx_stream_remaining == 0 {
            conn.rx_stream_drop = false;
        }
        chunk_off = n;
    }

    if chunk_off == chunk.len() {
        return Some(assemble(
            &mut conn.rx_ctrl_bytes,
            &mut conn.rx_ctrl_fds,
            head,
            out,
            new_bytes,
            new_fds,
        ));
    }

    let head_idx = conn.rx_buf.len();
    conn.rx_buf.extend_from_slice(&chunk[chunk_off..]);

    let mut off = 0;
    while off < conn.rx_buf.len() {
        if conn.rx_state == State::Setup {
            if conn.rx_buf.len() - off < 8 {
                if off <= head_idx {
                    head = HeadDisp::Buffered;
                }
                break;
            }
            let status = conn.rx_buf[off];
            let total = if status == 1 || status == 2 {
                8 + (r16(&conn.rx_buf[off + 6..off + 8], conn.is_le) as usize) * 4
            } else {
                8 + ((conn.rx_buf[off + 1] as usize + 3) & !3)
            };
            if conn.rx_buf.len() - off < total {
                if off <= head_idx && head_idx < off + total {
                    head = HeadDisp::Buffered;
                }
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

            if off <= head_idx && head_idx < off + total {
                head = HeadDisp::Forwarded;
            }
            conn.rx_state = State::Connected;
            out.extend_from_slice(&conn.rx_buf[off..off + total]);
            off += total;
        } else {
            if conn.rx_buf.len() - off < 32 {
                if off <= head_idx {
                    head = HeadDisp::Buffered;
                }
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
                        let mut stale = std::mem::take(&mut conn.rx_ctrl_fds);
                        stale.extend(new_fds);
                        close_ctrl_fds(stale);
                        return None;
                    };
                    let Some(total) = 32usize.checked_add(extra) else {
                        log_parser_close(fd, "inbound", "server message length overflow", 0);
                        let mut stale = std::mem::take(&mut conn.rx_ctrl_fds);
                        stale.extend(new_fds);
                        close_ctrl_fds(stale);
                        return None;
                    };
                    total
                }
                _ => 32,
            };
            let inspect_len = if code & 0x7F == 35 { total.min(40) } else { 32 };
            if conn.rx_buf.len() - off < inspect_len {
                if off <= head_idx && head_idx < off + total {
                    head = HeadDisp::Buffered;
                }
                break;
            }

            let seq = r16(&conn.rx_buf[off + 2..off + 4], conn.is_le);
            let mut drop = false;

            if is_reply_or_error {
                drop = handlers::replies::on_reply(conn, code, seq, off);
            }

            let available = conn.rx_buf.len() - off;
            let forward_len = available.min(total);
            if off <= head_idx && head_idx < off + total {
                head = if drop {
                    HeadDisp::Dropped
                } else if head_idx < off + forward_len {
                    HeadDisp::Forwarded
                } else {
                    HeadDisp::Buffered
                };
            }
            let out_start = out.len();
            if !drop {
                let evt_code = code & 0x7F;
                out.extend_from_slice(&conn.rx_buf[off..off + forward_len]);

                handlers::sequence::rewrite_seq(conn, seq, evt_code, &mut out, out_start);

                let is_press = handlers::button::track_button(conn, evt_code, off, inspect_len);
                let is_touch = !is_press
                    && handlers::button::track_touch_begin(conn, evt_code, off, inspect_len);

                if is_press {
                    conn.press_accum.clear();
                    conn.press_accum
                        .extend_from_slice(&out[out_start..out_start + forward_len]);
                    conn.press_remaining = total - forward_len;
                    if conn.press_remaining == 0 {
                        conn.last_button_press = Some(std::mem::take(&mut conn.press_accum));
                        conn.last_gesture = Some(GestureKind::Button);
                    }
                } else if is_touch {
                    conn.touch_accum.clear();
                    conn.touch_accum
                        .extend_from_slice(&out[out_start..out_start + forward_len]);
                    conn.touch_remaining = total - forward_len;
                    if conn.touch_remaining == 0 {
                        conn.last_touch_begin = Some(std::mem::take(&mut conn.touch_accum));
                        conn.last_gesture = Some(GestureKind::TouchBegin);
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
        let mut stale = std::mem::take(&mut conn.rx_ctrl_fds);
        stale.extend(new_fds);
        close_ctrl_fds(stale);
        return None;
    }
    Some(assemble(
        &mut conn.rx_ctrl_bytes,
        &mut conn.rx_ctrl_fds,
        head,
        out,
        new_bytes,
        new_fds,
    ))
}

pub(crate) fn feed_outbound(fd: RawFd, chunk: &[u8], cmsg: Option<Cmsg>) -> Option<Filtered> {
    update_last_active_fd(fd);
    let (new_bytes, new_fds) = split_cmsg(cmsg);
    let Some(m) = X11_CONNS.get() else {
        return Some(passthrough(chunk, new_bytes, new_fds));
    };
    let Ok(mut map) = m.lock() else {
        return Some(passthrough(chunk, new_bytes, new_fds));
    };
    let Some(conn) = map.get_mut(&fd) else {
        return Some(passthrough(chunk, new_bytes, new_fds));
    };

    let mut out = Vec::new();
    let mut chunk_off = 0;
    let mut head = HeadDisp::Forwarded;
    if conn.tx_stream_remaining > 0 {
        let n = conn.tx_stream_remaining.min(chunk.len());
        out.extend_from_slice(&chunk[..n]);
        conn.tx_stream_remaining -= n;
        chunk_off = n;
    }

    if chunk_off == chunk.len() {
        return Some(assemble(
            &mut conn.tx_ctrl_bytes,
            &mut conn.tx_ctrl_fds,
            head,
            out,
            new_bytes,
            new_fds,
        ));
    }

    let head_idx = conn.tx_buf.len();
    conn.tx_buf.extend_from_slice(&chunk[chunk_off..]);

    let mut off = 0;
    while off < conn.tx_buf.len() {
        if conn.tx_state == State::Setup {
            if conn.tx_buf.len() - off < 12 {
                if off <= head_idx {
                    head = HeadDisp::Buffered;
                }
                break;
            }
            let is_le = conn.tx_buf[off] == b'l';
            let nlen = r16(&conn.tx_buf[off + 6..off + 8], is_le);
            let dlen = r16(&conn.tx_buf[off + 8..off + 10], is_le);
            let total = 12 + ((nlen + 3) & !3) as usize + ((dlen + 3) & !3) as usize;
            if conn.tx_buf.len() - off < total {
                if off <= head_idx && head_idx < off + total {
                    head = HeadDisp::Buffered;
                }
                break;
            }

            if off <= head_idx && head_idx < off + total {
                head = HeadDisp::Forwarded;
            }
            conn.is_le = is_le;
            conn.tx_state = State::Connected;
            out.extend_from_slice(&conn.tx_buf[off..off + total]);
            off += total;

            let (req1, req2, req3) = handlers::setup::initial_requests(conn);
            out.extend_from_slice(&req1);
            out.extend_from_slice(&req2);
            out.extend_from_slice(&req3);
        } else {
            if conn.tx_buf.len() - off < 4 {
                if off <= head_idx {
                    head = HeadDisp::Buffered;
                }
                break;
            }
            let mut words = r16(&conn.tx_buf[off + 2..off + 4], conn.is_le) as usize;
            let mut hdr = 4;
            if words == 0 {
                if conn.tx_buf.len() - off < 8 {
                    if off <= head_idx {
                        head = HeadDisp::Buffered;
                    }
                    break;
                }
                words = r32(&conn.tx_buf[off + 4..off + 8], conn.is_le) as usize;
                hdr = 8;
            }
            let Some(total) = checked_word_len(words) else {
                log_parser_close(fd, "outbound", "client request length overflow", 0);
                let mut stale = std::mem::take(&mut conn.tx_ctrl_fds);
                stale.extend(new_fds);
                close_ctrl_fds(stale);
                return None;
            };
            if total < hdr {
                log_parser_close(
                    fd,
                    "outbound",
                    "client request length is shorter than its header",
                    conn.tx_buf.len() - off,
                );
                let mut stale = std::mem::take(&mut conn.tx_ctrl_fds);
                stale.extend(new_fds);
                close_ctrl_fds(stale);
                return None;
            }
            if conn.tx_buf.len() - off < total && total <= X11_BUFFER_LIMIT {
                if off <= head_idx && head_idx < off + total {
                    head = HeadDisp::Buffered;
                }
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
            if off <= head_idx && head_idx < off + total {
                head = if head_idx < off + forward_len {
                    HeadDisp::Forwarded
                } else {
                    HeadDisp::Buffered
                };
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
        let mut stale = std::mem::take(&mut conn.tx_ctrl_fds);
        stale.extend(new_fds);
        close_ctrl_fds(stale);
        return None;
    }
    Some(assemble(
        &mut conn.tx_ctrl_bytes,
        &mut conn.tx_ctrl_fds,
        head,
        out,
        new_bytes,
        new_fds,
    ))
}

#[cfg(test)]
mod tests {
    use std::os::fd::{AsRawFd, RawFd};
    use std::os::unix::net::UnixStream;
    use std::sync::MutexGuard;

    use super::*;

    /// Pad a length to the next 4-byte boundary, as the wire format does.
    fn pad4(len: usize) -> usize {
        (len + 3) & !3
    }

    /// The client's connection setup request.
    fn setup_request(le: bool, auth_name: u16, auth_data: u16) -> Vec<u8> {
        let mut buf = vec![0u8; 12 + pad4(auth_name as usize) + pad4(auth_data as usize)];
        buf[0] = if le { b'l' } else { b'B' };
        write_u16(&mut buf[2..4], 11, le);
        write_u16(&mut buf[6..8], auth_name, le);
        write_u16(&mut buf[8..10], auth_data, le);
        buf
    }

    /// The server's setup reply with one screen whose root window is `root`.
    fn setup_reply(le: bool, root: u32, vendor: &[u8], formats: usize) -> Vec<u8> {
        let screen_off = 40 + pad4(vendor.len()) + formats * 8;
        let mut buf = vec![0u8; screen_off + 8];
        let total = buf.len();
        buf[0] = 1; // Success
        write_u16(&mut buf[6..8], ((total - 8) / 4) as u16, le);
        write_u16(&mut buf[24..26], vendor.len() as u16, le);
        buf[29] = formats as u8;
        buf[40..40 + vendor.len()].copy_from_slice(vendor);
        write_u32(&mut buf[screen_off..screen_off + 4], root, le);
        buf
    }

    /// A 32-byte server reply or error carrying `seq`.
    fn reply(le: bool, seq: u16) -> Vec<u8> {
        let mut buf = vec![0u8; 32];
        buf[0] = 1;
        write_u16(&mut buf[2..4], seq, le);
        buf
    }

    /// A 32-byte event of the given code and sequence.
    fn event(le: bool, code: u8, seq: u16) -> Vec<u8> {
        let mut buf = vec![0u8; 32];
        buf[0] = code;
        write_u16(&mut buf[2..4], seq, le);
        buf
    }

    /// A client request with a 4-byte header (`words` counts 4-byte units).
    fn request(le: bool, opcode: u8, words: u16) -> Vec<u8> {
        let mut buf = vec![0u8; words as usize * 4];
        buf[0] = opcode;
        write_u16(&mut buf[2..4], words, le);
        buf
    }

    /// A client request using the 8-byte "big request" header, where the length
    /// is a 32-bit count of 4-byte units.
    fn big_request(opcode: u8, words: u32) -> Vec<u8> {
        let mut buf = vec![0u8; 8];
        buf[0] = opcode;
        write_u32(&mut buf[4..8], words, true);
        buf
    }

    /// An fd with filter state that only this test can see.
    struct Conn {
        stream: UnixStream,
        /// Kept open so the peer never disappears mid-test.
        _peer: UnixStream,
        /// Held for as long as the fixture lives. `X11_CONNS` and
        /// `LAST_ACTIVE_FD` are process-global, and every `feed_inbound` call
        /// rewrites `LAST_ACTIVE_FD`, so a test running concurrently in another
        /// module would otherwise see this test's fd as the "last active" one
        /// (and, in the other direction, steal it away).
        _serial: MutexGuard<'static, ()>,
    }

    impl Conn {
        fn new() -> Self {
            init_state();
            let serial = lock_globals();
            let (stream, peer) = UnixStream::pair().expect("socketpair");
            let conn = Self {
                stream,
                _peer: peer,
                _serial: serial,
            };
            conn.forget();
            conn.register();
            conn
        }

        /// An fd the proxy knows nothing about.
        fn unregistered() -> Self {
            init_state();
            let serial = lock_globals();
            let (stream, peer) = UnixStream::pair().expect("socketpair");
            let conn = Self {
                stream,
                _peer: peer,
                _serial: serial,
            };
            conn.forget();
            conn
        }

        fn fd(&self) -> RawFd {
            self.stream.as_raw_fd()
        }

        fn forget(&self) {
            if let Some(m) = X11_CONNS.get() {
                m.lock().unwrap().remove(&self.fd());
            }
        }

        fn register(&self) {
            X11_CONNS
                .get()
                .expect("initialised")
                .lock()
                .unwrap()
                .insert(self.fd(), X11Conn::new());
        }

        fn inbound(&self, chunk: &[u8]) -> Option<Filtered> {
            feed_inbound(self.fd(), chunk, None)
        }

        fn outbound(&self, chunk: &[u8]) -> Option<Filtered> {
            feed_outbound(self.fd(), chunk, None)
        }

        /// Run `check` against the connection state kept for this fd.
        fn with_conn<T>(&self, check: impl FnOnce(&X11Conn) -> T) -> T {
            let map = X11_CONNS.get().expect("initialised");
            let guard = map.lock().unwrap();
            check(guard.get(&self.fd()).expect("a connection is registered"))
        }

        /// Take the connection out so the test owns it.
        fn take(&self) -> X11Conn {
            X11_CONNS
                .get()
                .expect("initialised")
                .lock()
                .unwrap()
                .remove(&self.fd())
                .expect("a connection is registered")
        }
    }

    impl Drop for Conn {
        fn drop(&mut self) {
            self.forget();
        }
    }

    #[test]
    fn an_unknown_fd_is_passed_through_untouched() {
        let conn = Conn::unregistered();
        let chunk = setup_request(true, 0, 0);

        let out = conn.outbound(&chunk).expect("never tears down");
        assert_eq!(out.data, chunk);
        assert!(out.cmsg.is_empty() && out.fds_to_close.is_empty());

        let inbound = conn.inbound(&event(true, 2, 5)).expect("never tears down");
        assert_eq!(inbound.data.len(), 32);
    }

    #[test]
    fn the_setup_is_forwarded_then_the_probe_requests_are_injected() {
        let conn = Conn::new();
        let setup = setup_request(true, 0, 0);

        let out = conn.outbound(&setup).expect("never tears down");

        assert_eq!(out.data.len(), setup.len() + 68, "28 + 16 + 24 probe bytes");
        assert_eq!(&out.data[..setup.len()], setup.as_slice());

        let probes = &out.data[setup.len()..];
        assert_eq!(probes[0], 16, "InternAtom");
        assert_eq!(&probes[8..26], b"_NET_WM_MOVERESIZE");
        assert_eq!(probes[28], 98, "QueryExtension");
        assert_eq!(&probes[36..41], b"SHAPE");
        assert_eq!(probes[44], 98, "QueryExtension");
        assert_eq!(&probes[52..67], b"XInputExtension");

        let conn = conn.take();
        assert!(conn.is_le);
        assert_eq!(conn.tx_state, State::Connected);
        assert_eq!(conn.server_seq, 3, "one sequence per injected request");
        assert_eq!(conn.seq_offset, 3);
        assert_eq!(
            conn.injected_seqs.get(&1),
            Some(&InjectedType::InternAtomNetWmMoveresize)
        );
        assert_eq!(
            conn.injected_seqs.get(&2),
            Some(&InjectedType::QueryExtensionShape)
        );
        assert_eq!(
            conn.injected_seqs.get(&3),
            Some(&InjectedType::QueryExtensionXInput)
        );
        assert_eq!(
            conn.offset_transitions.last(),
            Some(&(2, 3)),
            "the offset takes effect from the first injected sequence"
        );
    }

    #[test]
    fn a_big_endian_client_gets_big_endian_probes() {
        let conn = Conn::new();
        let setup = setup_request(false, 0, 0);

        let out = conn.outbound(&setup).expect("never tears down");

        // The probe lengths are written in the client's byte order.
        let probes = &out.data[setup.len()..];
        assert_eq!(&probes[2..4], &[0, 7], "InternAtom length");
        assert_eq!(&probes[30..32], &[0, 4], "QueryExtension length");
        assert_eq!(&probes[46..48], &[0, 6], "QueryExtension length");

        let conn = conn.take();
        assert!(!conn.is_le);
        assert_eq!(conn.tx_state, State::Connected);
    }

    #[test]
    fn a_setup_split_across_chunks_is_buffered_until_complete() {
        let conn = Conn::new();
        // A big-endian client, so completing the setup has to change `is_le`.
        let setup = setup_request(false, 4, 8);

        let head = conn.outbound(&setup[..6]).expect("never tears down");
        assert!(head.data.is_empty(), "nothing is forwarded early");

        let tail = conn.outbound(&setup[6..]).expect("never tears down");

        assert_eq!(&tail.data[..setup.len()], setup.as_slice());
        assert_eq!(tail.data.len(), setup.len() + 68);
        assert!(!conn.with_conn(|c| c.is_le), "the client's byte order wins");
    }

    #[test]
    fn plain_requests_are_forwarded_and_counted() {
        let conn = Conn::new();
        conn.outbound(&setup_request(true, 0, 0)).expect("setup");

        let req = request(true, 43, 4);
        let out = conn.outbound(&req).expect("never tears down");

        assert_eq!(out.data, req);
        let conn = conn.take();
        assert_eq!(conn.client_seq, 1);
        assert_eq!(conn.server_seq, 4, "three probes plus this request");
    }

    #[test]
    fn a_request_using_the_big_header_is_read_by_its_long_length() {
        let conn = Conn::new();
        conn.outbound(&setup_request(true, 0, 0)).expect("setup");

        let mut req = big_request(43, 4);
        req.resize(16, 0);
        let out = conn.outbound(&req).expect("never tears down");

        assert_eq!(out.data, req);
    }

    #[test]
    fn a_big_header_that_understates_its_length_is_rejected() {
        let conn = Conn::new();
        conn.outbound(&setup_request(true, 0, 0)).expect("setup");

        // Eight-byte header, but the declared length is shorter than the header.
        assert!(
            conn.outbound(&big_request(43, 1)).is_none(),
            "the stream cannot be resynchronised"
        );
    }

    #[test]
    fn a_request_split_across_chunks_is_buffered_until_complete() {
        let conn = Conn::new();
        conn.outbound(&setup_request(true, 0, 0)).expect("setup");
        let req = request(true, 43, 8);

        let head = conn.outbound(&req[..16]).expect("never tears down");
        assert!(head.data.is_empty());

        let tail = conn.outbound(&req[16..]).expect("never tears down");
        assert_eq!(tail.data, req);
    }

    #[test]
    fn the_root_window_is_parsed_out_of_the_server_setup() {
        for (vendor, formats) in [(b"".as_slice(), 0), (b"TestVendor", 1)] {
            let conn = Conn::new();
            let reply = setup_reply(true, 0x1234_5678, vendor, formats);

            let out = conn.inbound(&reply).expect("never tears down");

            assert_eq!(out.data, reply, "the setup is forwarded unchanged");
            let conn = conn.take();
            assert_eq!(conn.rx_state, State::Connected);
            assert_eq!(
                conn.root_window, 0x1234_5678,
                "vendor={vendor:?} formats={formats}"
            );
        }
    }

    #[test]
    fn replies_to_the_probes_are_swallowed_and_harvested() {
        let conn = Conn::new();
        conn.outbound(&setup_request(true, 0, 0)).expect("setup");
        let setup = setup_reply(true, 0x1000, b"", 0);
        assert_eq!(conn.inbound(&setup).expect("setup reply").data, setup);

        // InternAtom(_NET_WM_MOVERESIZE) reply carries the atom.
        let mut atom = reply(true, 1);
        write_u32(&mut atom[8..12], 0xDEAD_BEEF, true);
        assert!(
            conn.inbound(&atom)
                .expect("never tears down")
                .data
                .is_empty()
        );

        // QueryExtension(SHAPE) reply: present flag then the opcode.
        let mut shape = reply(true, 2);
        shape[8] = 1;
        shape[9] = 130;
        assert!(
            conn.inbound(&shape)
                .expect("never tears down")
                .data
                .is_empty()
        );

        let mut xinput = reply(true, 3);
        xinput[8] = 1;
        xinput[9] = 131;
        assert!(
            conn.inbound(&xinput)
                .expect("never tears down")
                .data
                .is_empty()
        );

        // A reply nobody injected is forwarded, with its sequence rewritten
        // back into the client's own numbering.
        let other = reply(true, 99);
        let forwarded = conn.inbound(&other).expect("never tears down");
        assert_eq!(forwarded.data.len(), 32);
        assert_eq!(r16(&forwarded.data[2..4], true), 96);

        let conn = conn.take();
        assert_eq!(conn.net_wm_moveresize, Some(0xDEAD_BEEF));
        assert_eq!(conn.shape_opcode, Some(130));
        assert_eq!(conn.xi_opcode, Some(131));
        assert!(conn.injected_seqs.is_empty(), "each reply is consumed once");
    }

    #[test]
    fn forwarded_events_have_their_sequence_rewritten() {
        let conn = Conn::new();
        conn.outbound(&setup_request(true, 0, 0)).expect("setup");
        let setup = setup_reply(true, 0x1000, b"", 0);
        conn.inbound(&setup).expect("setup reply");

        // The client never saw the three injected requests, so the server's
        // sequence is three ahead of the client's view.
        let sent = event(true, 2, 100);
        let out = conn.inbound(&sent).expect("never tears down");

        assert_eq!(out.data.len(), 32);
        assert_eq!(r16(&out.data[2..4], true), 97);
        assert_eq!(&out.data[8..], &sent[8..], "only the sequence changed");
    }

    #[test]
    fn a_request_at_the_buffer_limit_is_released_rather_than_held() {
        let conn = Conn::new();
        conn.outbound(&setup_request(true, 0, 0)).expect("setup");

        // A request that declares exactly the buffer limit and arrives in 64 KiB
        // pieces. The proxy holds it until the whole request is present, then
        // forwards it and drains — a request *larger* than the limit is streamed
        // through as it arrives instead. That is why the hard backlog guard
        // (`tx_buf.len() > X11_BUFFER_LIMIT`) cannot be reached: the buffer can
        // only grow while the request is incomplete, and an incomplete request
        // that big is never buffered in the first place.
        let chunk = {
            let mut buf = big_request(43, (X11_BUFFER_LIMIT / 4) as u32);
            buf.resize(64 * 1024, 0);
            buf
        };

        let mut forwarded = Vec::new();
        for _ in 0..(X11_BUFFER_LIMIT / chunk.len()) {
            let out = conn.outbound(&chunk).expect("never tears down");
            forwarded.extend_from_slice(&out.data);
        }

        assert_eq!(
            forwarded.len(),
            X11_BUFFER_LIMIT,
            "the whole request is released once complete"
        );
        assert!(
            conn.with_conn(|c| c.tx_buf.is_empty()),
            "nothing is left buffered"
        );
    }

    #[test]
    fn a_request_over_the_buffer_limit_is_streamed_not_held() {
        let conn = Conn::new();
        conn.outbound(&setup_request(true, 0, 0)).expect("setup");

        // Declares more than the limit: the first chunk is already forwarded
        // instead of being buffered, so the backlog never builds up.
        let mut chunk = big_request(43, (X11_BUFFER_LIMIT / 4) as u32 + 1);
        chunk.resize(64 * 1024, 0);

        let out = conn.outbound(&chunk).expect("never tears down");

        assert_eq!(out.data, chunk, "forwarded as it arrives");
        assert!(conn.with_conn(|c| c.tx_buf.is_empty()));
    }
}
