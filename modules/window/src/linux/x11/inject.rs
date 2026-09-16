use std::{
    sync::{Arc, Condvar, Mutex},
    time::Duration,
};

use crate::linux::Rect;

use super::super::proxy::{Sink, sink_for};
use super::codec::*;
use super::state::*;

/// Drag the given X11 window by synthesizing the `_NET_WM_MOVERESIZE`
/// protocol: UngrabPointer + SendEvent(ClientMessage) + GetInputFocus.
///
/// A drag initiated from a touch sequence needs two extra steps a button
/// drag does not: reject the touch via `XIAllowTouchEvents` so the WM's
/// core-pointer grab actually follows the finger, and feed the client a
/// synthetic `XI_TouchEnd` so Chromium doesn't keep an unterminated touch.
pub(crate) fn move_window(conn: &mut X11Conn, sink: &Sink, window: u32) -> bool {
    let Some(atom) = conn.net_wm_moveresize else {
        return false;
    };
    if conn.root_window == 0 {
        return false;
    }

    let is_touch = conn.last_gesture == Some(GestureKind::TouchBegin);
    let can_reject = is_touch && conn.xi_opcode.is_some();

    // Injected requests: UngrabPointer, SendEvent, GetInputFocus, plus
    // XIAllowTouchEvents for touch-initiated drags.
    conn.begin_injected_requests(if can_reject { 4 } else { 3 });

    // Synthesize the matching terminator so the client doesn't see a stuck
    // button or an unterminated touch sequence.
    if can_reject {
        if let Some(end) = conn
            .last_touch_begin
            .as_ref()
            .and_then(|begin| build_touch_end(begin, conn.is_le))
        {
            conn.pending_inbound.extend_from_slice(&end);
        }
    } else if let Some(release) = conn
        .last_button_press
        .as_ref()
        .and_then(|p| build_release(p, conn.is_le))
    {
        conn.pending_inbound.extend_from_slice(&release);
    }

    let mut payload = build_moveresize_move_payload(conn, window, atom);
    if can_reject && let Some(begin) = conn.last_touch_begin.as_ref() {
        payload.extend_from_slice(&build_allow_touch_reject(conn, begin));
    }
    sink.send_to_server(&payload)
}

/// Core ButtonPress → ButtonRelease; XI2 ButtonPress → ButtonRelease.
fn build_release(press: &[u8], is_le: bool) -> Option<Vec<u8>> {
    let mut release = press.to_vec();
    let code = release[0] & 0x7F;
    if code == 4 {
        release[0] = (release[0] & 0x80) | 5;
    } else if code == 35 && release.len() >= 10 {
        write_u16(&mut release[8..10], 5, is_le);
    }
    Some(release)
}

/// Morph a captured `XI_TouchBegin` into a synthetic `XI_TouchEnd` by flipping
/// the evtype. The captured bytes were already sequence-rewritten into client
/// space, so the result can be queued straight into `pending_inbound`
/// (mirroring how `build_release` reuses the press bytes).
fn build_touch_end(begin: &[u8], is_le: bool) -> Option<Vec<u8>> {
    if begin.len() < 10 {
        return None;
    }
    let mut end = begin.to_vec();
    write_u16(&mut end[8..10], XI_EV_TOUCH_END, is_le);
    Some(end)
}

/// Build an `XIAllowTouchEvents(XIRejectTouch)` request for the captured touch
/// sequence. Rejecting hands the sequence over to core-pointer emulation so the
/// window manager's interactive-move grab actually follows the finger.
///
/// Wire format is the XI 2.2 `xXI2_2AllowEventsReq`: it is the XIAllowEvents
/// request (`ReqType = XI_ALLOW_EVENTS`) with `touchid`/`grab_window` appended.
fn build_allow_touch_reject(conn: &X11Conn, begin: &[u8]) -> Vec<u8> {
    let is_le = conn.is_le;

    // xXIDeviceEvent wire offsets: deviceid@10, detail(touch id)@16,
    // event window@24.
    let deviceid = r16(&begin[10..12], is_le);
    let touchid = r32(&begin[16..20], is_le);
    // XIAllowTouchEvents wants the window the touch was delivered to (the
    // xXIDeviceEvent `event` field), not the root.
    let grab_window = if begin.len() >= 28 {
        r32(&begin[24..28], is_le)
    } else {
        conn.root_window
    };

    // xXI2_2AllowEventsReq layout (24 bytes = length 6):
    //   reqType, ReqType, length, deviceid, pad, mode, time, touchid,
    //   grab_window.
    let mut p = vec![0u8; 24];
    p[0] = conn.xi_opcode.unwrap_or(0);
    p[1] = XI_ALLOW_EVENTS;
    write_u16(&mut p[2..4], 6, is_le);
    write_u16(&mut p[4..6], deviceid, is_le);
    // p[6..8] pad
    write_u32(&mut p[8..12], XI_REJECT_TOUCH, is_le);
    write_u32(&mut p[12..16], 0, is_le); // time = CurrentTime (0)
    write_u32(&mut p[16..20], touchid, is_le);
    write_u32(&mut p[20..24], grab_window, is_le);
    p
}

fn build_moveresize_move_payload(conn: &X11Conn, window: u32, atom: u32) -> Vec<u8> {
    let is_le = conn.is_le;
    let mut p = vec![0u8; 56];

    // 1) UngrabPointer — release any active button grab before the move.
    p[0] = 27;
    write_u16(&mut p[2..4], 2, is_le); // request length: 2 words
    write_u32(&mut p[4..8], 0, is_le); // grab window = PointerWindow

    // 2) SendEvent wrapping a ClientMessage(_NET_WM_MOVERESIZE).
    p[8] = 25;
    p[9] = 0; // propagate = false
    write_u16(&mut p[10..12], 11, is_le); // request length: 11 words
    write_u32(&mut p[12..16], conn.root_window, is_le);
    write_u32(&mut p[16..20], 0x180000, is_le); // SubstructureRedirect | SubstructureNotify

    p[20] = 33; // ClientMessage
    p[21] = 32; // format = 32-bit
    write_u16(&mut p[22..24], 0, is_le); // sequence — filled in by the server
    write_u32(&mut p[24..28], window, is_le);
    write_u32(&mut p[28..32], atom, is_le); // _NET_WM_MOVERESIZE
    write_u32(&mut p[32..36], conn.root_x as u32, is_le);
    write_u32(&mut p[36..40], conn.root_y as u32, is_le);
    write_u32(&mut p[40..44], 8, is_le); // direction = _NET_WM_MOVERESIZE_MOVE
    write_u32(&mut p[44..48], conn.button as u32, is_le);
    write_u32(&mut p[48..52], 1, is_le); // source = application

    // 3) GetInputFocus — force an immediate reply so the client's poll/select
    //    wakes and flushes the queued synthetic ButtonRelease; its reply is
    //    dropped via injected_seqs tracking in filter.rs.
    p[52] = 43;
    p[53] = 0; // pad
    write_u16(&mut p[54..56], 1, is_le); // request length: 1 word

    p
}

pub(crate) fn set_input_region(
    conn: &mut X11Conn,
    sink: &Sink,
    window: u32,
    rects: Option<&[Rect]>,
) -> bool {
    let Some(shape_opcode) = conn.shape_opcode else {
        return false;
    };

    conn.begin_injected_requests(1);

    let is_le = conn.is_le;

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
        sink.send_to_server(&payload)
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

        sink.send_to_server(&payload)
    }
}

pub(crate) fn query_pointer(window: u32) -> Option<(i16, i16)> {
    let fd = last_active_fd()?;
    let sink = sink_for(fd)?;
    let write_lock = sink.write_lock.as_ref()?;
    let write_guard = write_lock.lock().ok()?;

    let pending = Arc::new(QueryPointerPending {
        result: Mutex::new(None),
        condvar: Condvar::new(),
    });

    let (is_le, window) = {
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
        // Offset starts at the injected request's own sequence (see
        // begin_injected_requests for why this matters).
        conn.offset_transitions
            .push((conn.server_seq, conn.seq_offset));
        if conn.offset_transitions.len() > 32 {
            conn.offset_transitions.drain(0..16);
        }
        conn.injected_seqs
            .retain(|&k, _| conn.server_seq.wrapping_sub(k) < 32768);

        (conn.is_le, effective_window)
    };

    let mut payload = [0u8; 8];
    payload[0] = 38; // QueryPointer opcode
    write_u16(&mut payload[2..4], 2, is_le); // length = 2 words
    write_u32(&mut payload[4..8], window, is_le);

    if !sink.send_to_server(&payload) {
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
    // Release write lock before waiting — inbound processing in filter.rs does
    // not require the write lock, so the proxy loop can still deliver the reply.
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

#[cfg(test)]
mod tests {
    use std::io::Read;
    use std::os::fd::{AsRawFd, RawFd};
    use std::os::unix::net::UnixStream;
    use std::time::Instant;

    use crate::linux::proxy::SINKS;

    use super::super::filter::feed_inbound;
    use super::*;

    /// A connection that is ready to have a drag or a shape change injected.
    fn conn() -> X11Conn {
        let mut conn = X11Conn::new();
        conn.is_le = true;
        conn.root_window = 0x1000;
        conn.root_x = 10;
        conn.root_y = 20;
        conn.button = 1;
        conn.net_wm_moveresize = Some(0xABCD);
        conn.shape_opcode = Some(130);
        conn.xi_opcode = Some(131);
        conn
    }

    /// A core `ButtonPress` (event code 4) of the usual 32 bytes.
    fn core_press(detail: u8) -> Vec<u8> {
        let mut buf = vec![0u8; 32];
        buf[0] = 4;
        buf[1] = detail;
        buf
    }

    /// An XI2 `XI_TouchBegin` (GenericEvent, evtype 18).
    fn touch_begin() -> Vec<u8> {
        let mut buf = vec![0u8; 40];
        buf[0] = XI_GENERIC_EVENT;
        write_u16(&mut buf[8..10], XI_EV_TOUCH_BEGIN, true);
        write_u16(&mut buf[10..12], 9, true); // deviceid
        write_u32(&mut buf[16..20], 0x77, true); // touch id
        write_u32(&mut buf[20..24], 0x1000, true); // root
        write_u32(&mut buf[24..28], 0x2000, true); // event window
        buf
    }

    /// A sink whose server-bound writes land in the returned socket.
    ///
    /// `Sink` only stores the raw descriptor, so ownership of the socket has to
    /// stay with the test: handing out the number and forgetting the socket (as
    /// this helper used to) leaks one descriptor per call, and a long-running
    /// test process would eventually run out of them.
    struct OpenSink {
        sink: Sink,
        _server: UnixStream,
    }

    impl std::ops::Deref for OpenSink {
        type Target = Sink;

        fn deref(&self) -> &Sink {
            &self.sink
        }
    }

    fn sink() -> (OpenSink, UnixStream) {
        let (server, peer) = UnixStream::pair().expect("socketpair");
        peer.set_nonblocking(true).expect("nonblocking");
        (
            OpenSink {
                sink: Sink {
                    real_fd: server.as_raw_fd(),
                    app_fd: server.as_raw_fd(),
                    write_lock: Some(Arc::new(Mutex::new(()))),
                },
                _server: server,
            },
            peer,
        )
    }

    /// A sink whose server-bound writes fail, because the fd is closed.
    /// A sink whose server-bound writes always fail.
    ///
    /// The descriptor is one that can never be valid. Closing a freshly opened
    /// socket would work too, but it frees that number: a test starting at the
    /// same time can reallocate it, making the "dead" descriptor live again and
    /// sending the payload into that test's socket.
    fn dead_sink() -> Sink {
        Sink {
            real_fd: -1,
            app_fd: -1,
            write_lock: Some(Arc::new(Mutex::new(()))),
        }
    }

    /// Everything written to the sink so far.
    fn received(peer: &mut UnixStream) -> Vec<u8> {
        let mut out = Vec::new();
        let mut buf = [0u8; 4096];
        while let Ok(n) = peer.read(&mut buf) {
            if n == 0 {
                break;
            }
            out.extend_from_slice(&buf[..n]);
        }
        out
    }

    /// A `QueryPointer` reply for `seq` reporting `(x, y)`.
    fn pointer_reply(seq: u16, x: i16, y: i16) -> Vec<u8> {
        let mut buf = vec![0u8; 32];
        buf[0] = 1; // Reply
        write_u16(&mut buf[2..4], seq, true);
        write_u16(&mut buf[16..18], x as u16, true);
        write_u16(&mut buf[18..20], y as u16, true);
        buf
    }

    #[test]
    fn a_core_press_becomes_a_release_of_the_same_button() {
        let press = core_press(3);
        let release = build_release(&press, true).expect("always derivable");

        assert_eq!(release[0], 5, "ButtonPress becomes ButtonRelease");
        assert_eq!(release[1], 3, "the button is preserved");
        assert_eq!(&release[2..], &press[2..], "nothing else changes");
    }

    #[test]
    fn an_xi2_press_becomes_an_xi2_release() {
        let mut press = touch_begin();
        write_u16(&mut press[8..10], 4, true); // XI_ButtonPress
        let release = build_release(&press, true).expect("derivable");

        assert_eq!(r16(&release[8..10], true), 5, "XI_ButtonRelease");
        assert_eq!(release[0], XI_GENERIC_EVENT, "the event code is untouched");
        assert_eq!(&release[10..], &press[10..]);
    }

    #[test]
    fn a_touch_begin_becomes_a_touch_end() {
        let begin = touch_begin();
        let end = build_touch_end(&begin, true).expect("derivable");

        assert_eq!(r16(&end[8..10], true), XI_EV_TOUCH_END);
        assert_eq!(end.len(), begin.len(), "same message, different type");
        assert_eq!(&end[10..], &begin[10..], "the touch id is preserved");

        assert!(build_touch_end(&begin[..9], true).is_none(), "too short");
    }

    #[test]
    fn rejecting_a_touch_reuses_the_device_and_window() {
        let begin = touch_begin();
        let conn = conn();
        let request = build_allow_touch_reject(&conn, &begin);

        assert_eq!(request.len(), 24);
        assert_eq!(request[0], 131, "the XI extension opcode");
        assert_eq!(request[1], XI_ALLOW_EVENTS);
        assert_eq!(r16(&request[2..4], true), 6, "6 words");
        assert_eq!(r16(&request[4..6], true), 9, "the originating device");
        assert_eq!(r32(&request[8..12], true), XI_REJECT_TOUCH);
        assert_eq!(r32(&request[12..16], true), 0, "CurrentTime");
        assert_eq!(r32(&request[16..20], true), 0x77, "the touch id");
        assert_eq!(
            r32(&request[20..24], true),
            0x2000,
            "the window the touch was delivered to"
        );
    }

    #[test]
    fn a_short_touch_begin_falls_back_to_the_root_window() {
        let begin = touch_begin()[..24].to_vec();
        let conn = conn();

        let request = build_allow_touch_reject(&conn, &begin);

        assert_eq!(r32(&request[20..24], true), 0x1000, "the root window");
    }

    #[test]
    fn the_move_payload_grabs_sends_and_flushes() {
        let conn = conn();
        let payload = build_moveresize_move_payload(&conn, 0x5000, 0xABCD);

        assert_eq!(payload.len(), 56, "3 requests in one write");

        // UngrabPointer: 2 words, PointerWindow.
        assert_eq!(&payload[0..8], &[27, 0, 2, 0, 0, 0, 0, 0]);

        // SendEvent wrapping the ClientMessage.
        assert_eq!(payload[8], 25, "SendEvent");
        assert_eq!(payload[9], 0, "propagate = false");
        assert_eq!(r16(&payload[10..12], true), 11, "11 words");
        assert_eq!(r32(&payload[12..16], true), 0x1000, "to the root window");
        assert_eq!(r32(&payload[16..20], true), 0x180000, "substructure mask");
        assert_eq!(payload[20], 33, "ClientMessage");
        assert_eq!(payload[21], 32, "32-bit format");
        assert_eq!(r32(&payload[24..28], true), 0x5000, "the window");
        assert_eq!(r32(&payload[28..32], true), 0xABCD, "the atom");
        assert_eq!(r32(&payload[32..36], true), 10, "root x");
        assert_eq!(r32(&payload[36..40], true), 20, "root y");
        assert_eq!(r32(&payload[40..44], true), 8, "_NET_WM_MOVERESIZE_MOVE");
        assert_eq!(r32(&payload[44..48], true), 1, "button 1");
        assert_eq!(r32(&payload[48..52], true), 1, "source = application");

        // GetInputFocus flushes the client's queue.
        assert_eq!(&payload[52..56], &[43, 0, 1, 0]);
    }

    #[test]
    fn a_button_drag_replays_a_release() {
        let (sink, mut peer) = sink();
        let mut conn = conn();
        conn.last_gesture = Some(GestureKind::Button);
        conn.last_button_press = Some(core_press(1));

        assert!(move_window(&mut conn, &sink, 0x5000));

        assert_eq!(received(&mut peer).len(), 56);
        assert_eq!(conn.pending_inbound.len(), 32, "a release is queued");
        assert_eq!(conn.pending_inbound[0], 5, "ButtonRelease");
        assert_eq!(conn.seq_offset, 3, "three injected requests");
        assert_eq!(
            conn.injected_seqs
                .values()
                .filter(|t| **t == InjectedType::Other)
                .count(),
            3
        );
    }

    #[test]
    fn a_touch_drag_rejects_the_sequence_and_ends_it() {
        let (sink, mut peer) = sink();
        let mut conn = conn();
        conn.last_gesture = Some(GestureKind::TouchBegin);
        conn.last_touch_begin = Some(touch_begin());

        assert!(move_window(&mut conn, &sink, 0x5000));

        assert_eq!(
            received(&mut peer).len(),
            56 + 24,
            "plus the reject request"
        );
        assert_eq!(r16(&conn.pending_inbound[8..10], true), XI_EV_TOUCH_END);
        assert_eq!(conn.seq_offset, 4, "four injected requests");
    }

    #[test]
    fn a_touch_without_the_xi_extension_falls_back_to_a_release() {
        let (sink, mut peer) = sink();
        let mut conn = conn();
        conn.xi_opcode = None;
        conn.last_gesture = Some(GestureKind::TouchBegin);
        conn.last_touch_begin = Some(touch_begin());
        conn.last_button_press = Some(core_press(1));

        assert!(move_window(&mut conn, &sink, 0x5000));

        assert_eq!(received(&mut peer).len(), 56, "no reject request");
        assert_eq!(conn.pending_inbound[0], 5, "a ButtonRelease instead");
    }

    #[test]
    fn a_drag_needs_an_atom_and_a_root_window() {
        let (sink, mut peer) = sink();

        let mut without_atom = conn();
        without_atom.net_wm_moveresize = None;
        assert!(!move_window(&mut without_atom, &sink, 0x5000));
        assert!(without_atom.pending_inbound.is_empty());

        let mut without_root = conn();
        without_root.root_window = 0;
        assert!(!move_window(&mut without_root, &sink, 0x5000));

        assert!(received(&mut peer).is_empty(), "nothing was sent");
    }

    #[test]
    fn a_failed_drag_send_is_reported() {
        let sink = dead_sink();
        let mut conn = conn();
        conn.last_gesture = Some(GestureKind::Button);
        conn.last_button_press = Some(core_press(1));

        assert!(!move_window(&mut conn, &sink, 0x5000));
    }

    #[test]
    fn shape_rectangles_carry_every_rect() {
        let (sink, mut peer) = sink();
        let mut conn = conn();
        let rects = [
            Rect {
                x: 1,
                y: 2,
                w: 3,
                h: 4,
            },
            Rect {
                x: 5,
                y: 6,
                w: 7,
                h: 8,
            },
        ];

        assert!(set_input_region(&mut conn, &sink, 0x5000, Some(&rects)));

        let sent = received(&mut peer);
        assert_eq!(
            sent.len(),
            (4 + rects.len() * 2) * 4,
            "4 + 2 words per rect"
        );
        assert_eq!(sent[0], 130, "the SHAPE opcode");
        assert_eq!(sent[1], 1, "ShapeRectangles");
        assert_eq!(r16(&sent[2..4], true), 8, "8 words");
        assert_eq!(sent[4], 0, "ShapeSet");
        assert_eq!(sent[5], 2, "ShapeInput");
        assert_eq!(r32(&sent[8..12], true), 0x5000);
        assert_eq!(r16(&sent[12..14], true), 0, "x offset");
        assert_eq!(r16(&sent[14..16], true), 0, "y offset");
        assert_eq!(
            &sent[16..32],
            &[1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8, 0],
            "rects are 4 unsigned 16-bit values"
        );
        assert_eq!(conn.seq_offset, 1, "one injected request");
    }

    #[test]
    fn a_null_region_resets_the_shape() {
        let (sink, mut peer) = sink();
        let mut conn = conn();

        assert!(set_input_region(&mut conn, &sink, 0x5000, None));

        let sent = received(&mut peer);
        assert_eq!(sent.len(), 20);
        assert_eq!(sent[1], 2, "ShapeMask");
        assert_eq!(r16(&sent[2..4], true), 5, "5 words");
        assert_eq!(r32(&sent[8..12], true), 0x5000);
        assert_eq!(r32(&sent[16..20], true), 0, "source_bitmap = None");
    }

    #[test]
    fn a_region_needs_the_shape_extension() {
        let (sink, mut peer) = sink();
        let mut conn = conn();
        conn.shape_opcode = None;

        assert!(!set_input_region(&mut conn, &sink, 0x5000, None));
        assert!(!set_input_region(
            &mut conn,
            &sink,
            0x5000,
            Some(&[Rect {
                x: 1,
                y: 2,
                w: 3,
                h: 4
            }])
        ));
        assert!(received(&mut peer).is_empty());
    }

    /// A fixture for the injection paths that go through the global registries.
    struct QueryFixture {
        /// Held to keep the socketpair's other end open, so writes to the sink
        /// cannot fail with EPIPE.
        _peer: UnixStream,
        /// Owns the descriptor the registries are keyed by. `Drop` cleans the
        /// registries first, then this field closes the socket — forgetting it
        /// instead would leak one descriptor per fixture.
        _server: UnixStream,
        fd: RawFd,
    }

    impl QueryFixture {
        fn new() -> Self {
            init_state();
            let (server, peer) = UnixStream::pair().expect("socketpair");
            peer.set_nonblocking(true).expect("nonblocking");
            let fd = server.as_raw_fd();

            let mut state = conn();
            state.server_seq = 1;
            state.seq_offset = 0;
            // A query only happens on an established connection, so the inbound
            // parser must not still be waiting for the setup handshake (that is
            // covered by the filter tests).
            state.rx_state = State::Connected;

            X11_CONNS
                .get()
                .expect("initialised")
                .lock()
                .unwrap()
                .insert(fd, state);
            SINKS.get_or_init(Default::default).lock().unwrap().insert(
                fd,
                Sink {
                    real_fd: fd,
                    app_fd: fd,
                    write_lock: Some(Arc::new(Mutex::new(()))),
                },
            );
            LAST_ACTIVE_FD
                .get_or_init(Default::default)
                .lock()
                .unwrap()
                .replace(fd);

            Self {
                _peer: peer,
                _server: server,
                fd,
            }
        }

        /// The sequence the injected `QueryPointer` was given.
        fn injected_sequence(&self) -> Option<u16> {
            let map = X11_CONNS.get()?.lock().ok()?;
            let conn = map.get(&self.fd)?;
            conn.injected_seqs
                .iter()
                .find(|(_, kind)| **kind == InjectedType::QueryPointer)
                .map(|(seq, _)| *seq)
        }

        fn with_conn<T>(&self, check: impl FnOnce(&X11Conn) -> T) -> T {
            let map = X11_CONNS.get().expect("initialised");
            let guard = map.lock().unwrap();
            check(guard.get(&self.fd).expect("a connection"))
        }
    }

    impl Drop for QueryFixture {
        fn drop(&mut self) {
            if let Some(m) = X11_CONNS.get() {
                m.lock().unwrap().remove(&self.fd);
            }
            if let Some(m) = SINKS.get() {
                m.lock().unwrap().remove(&self.fd);
            }
            if let Some(m) = LAST_ACTIVE_FD.get() {
                m.lock().unwrap().take();
            }
        }
    }

    #[test]
    fn a_pointer_query_waits_for_its_reply() {
        let _serial = lock_globals();
        let fixture = QueryFixture::new();
        let fd = fixture.fd;

        let query = std::thread::spawn(move || query_pointer(0));

        // Wait for the request to be recorded, then answer it.
        let deadline = Instant::now() + Duration::from_secs(2);
        let seq = loop {
            if let Some(seq) = fixture.injected_sequence() {
                break seq;
            }
            assert!(Instant::now() < deadline, "the query was never injected");
            std::thread::sleep(Duration::from_millis(5));
        };

        assert_eq!(
            feed_inbound(fd, &pointer_reply(seq, -7, 9), None)
                .expect("never tears down")
                .data,
            Vec::new(),
            "the reply is dropped rather than forwarded"
        );

        assert_eq!(query.join().expect("no panic"), Some((-7, 9)));
        assert!(
            fixture.with_conn(|c| c.query_pointer_pending.is_none()),
            "the pending query is cleared"
        );
    }

    #[test]
    fn a_pointer_query_that_cannot_be_sent_rolls_back() {
        let _serial = lock_globals();
        let fixture = QueryFixture::new();
        let before = fixture.with_conn(|c| (c.server_seq, c.seq_offset));

        // Break the sink so the request fails. The descriptor is deliberately
        // one that never existed rather than a freshly closed socket: `close` is
        // symbol-hooked in this crate, so calling it while holding the SINKS lock
        // below would re-enter that same lock and deadlock the test.
        SINKS.get().unwrap().lock().unwrap().insert(
            fixture.fd,
            Sink {
                real_fd: -1,
                app_fd: fixture.fd,
                write_lock: Some(Arc::new(Mutex::new(()))),
            },
        );

        assert_eq!(query_pointer(0), None);

        assert_eq!(
            fixture.with_conn(|c| (c.server_seq, c.seq_offset)),
            before,
            "the sequence bookkeeping is rolled back"
        );
        assert!(fixture.with_conn(|c| c.query_pointer_pending.is_none()));
        assert!(fixture.injected_sequence().is_none());
    }

    #[test]
    fn a_pointer_query_gives_up_when_no_reply_arrives() {
        let _serial = lock_globals();
        let fixture = QueryFixture::new();

        let started = Instant::now();
        assert_eq!(query_pointer(0), None);

        assert!(
            started.elapsed() >= Duration::from_millis(450),
            "it waits for the reply before giving up"
        );
        assert!(fixture.with_conn(|c| c.query_pointer_pending.is_none()));
    }

    #[test]
    fn a_pointer_query_needs_a_connection_and_a_sink() {
        let _serial = lock_globals();
        init_state();
        if let Some(m) = LAST_ACTIVE_FD.get() {
            m.lock().unwrap().take();
        }

        assert_eq!(query_pointer(0), None, "no active fd");
    }
}
