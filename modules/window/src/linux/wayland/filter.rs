use std::os::fd::RawFd;

use super::super::proxy::{Cmsg, Direction, Filtered};
use super::codec;
use super::handlers::{self, Action, Effects};
use super::state::*;

/// Stream pipeline: reassemble bytes → decode messages → run the functionality
/// handlers → reassemble forwarded bytes.
///
/// This is the only glue between the transport and the Wayland handlers; all
/// interception/injection rules live in `handlers/`.
pub(crate) fn filter(
    fd: RawFd,
    dir: Direction,
    chunk: &[u8],
    cmsg: Option<Cmsg>,
) -> Option<Filtered> {
    let is_event = dir == Direction::Inbound;
    let storage = if is_event { &RX_BUFS } else { &TX_BUFS };
    let ctrl_storage = if is_event {
        &RX_PENDING_CTRL
    } else {
        &TX_PENDING_CTRL
    };

    let (new_ctrl_bytes, new_ctrl_fds) = match cmsg {
        Some(Cmsg { bytes, fds }) => (bytes, fds),
        None => (Vec::new(), Vec::new()),
    };

    let Some(storage) = storage.get() else {
        return Some(Filtered {
            data: chunk.to_vec(),
            cmsg: new_ctrl_bytes,
            fds_to_close: new_ctrl_fds,
        });
    };

    let (msgs, sync_lost, dropped, mut pending_ctrl) = {
        let Ok(mut map) = storage.lock() else {
            return Some(Filtered {
                data: chunk.to_vec(),
                cmsg: new_ctrl_bytes,
                fds_to_close: new_ctrl_fds,
            });
        };
        let buf = map.entry(fd).or_default();
        buf.extend_from_slice(chunk);
        let (msgs, consumed) = codec::decode(&buf[..]);
        buf.drain(..consumed);
        let sync_lost = buf.len() > 4 << 20;
        let dropped = if sync_lost {
            let backlog = buf.len();
            buf.clear();
            backlog
        } else {
            0
        };

        let mut pending_ctrl = PendingControl::default();
        if let Some(m) = ctrl_storage.get()
            && let Ok(mut ctrl_map) = m.lock()
            && let Some(stored) = ctrl_map.remove(&fd)
        {
            pending_ctrl = stored;
        }

        (msgs, sync_lost, dropped, pending_ctrl)
    };

    let had_complete_msgs = !msgs.is_empty();

    // ── Functionality: dispatch each message to its handler ──
    let mut out = Vec::new();
    let mut fx = Effects::default();
    {
        let conns = CONNS.get();
        let mut guard = conns.and_then(|m| m.lock().ok());
        for msg in &msgs {
            let action = if let Some(conn) = guard.as_mut().and_then(|g| g.get_mut(&fd)) {
                if is_event {
                    handlers::dispatch_event(conn, msg, &mut fx)
                } else {
                    handlers::dispatch_request(fd, conn, msg, &mut fx)
                }
            } else {
                Action::Forward
            };

            match action {
                Action::Forward => out.extend_from_slice(msg.raw()),
                Action::Suppress => {}
            }
        }
    }

    // Apply side effects after releasing the connection lock.
    if let Some((seat_id, serial, surf_id)) = fx.button
        && let Some(m) = LAST_BUTTON.get()
        && let Ok(mut opt) = m.lock()
    {
        *opt = Some((fd, seat_id, serial, surf_id));
    }
    if let Some((wl_surface_id, x, y)) = fx.entered {
        fire_first_cursor_enter_watchers(fd, wl_surface_id, x, y);
    }
    if let Some(wl_surface_id) = fx.arm_watchers_for {
        arm_first_cursor_enter_watchers(fd, wl_surface_id);
    }

    // ── Ancillary data + output assembly (unchanged semantics) ──
    pending_ctrl.bytes.extend_from_slice(&new_ctrl_bytes);
    pending_ctrl.fds.extend(new_ctrl_fds);

    if sync_lost {
        // Deliberately not `None`: the caller tears the connection down for that,
        // which would kill the app's display connection. Once a backlog this
        // large has accumulated the byte stream no longer lines up with what the
        // compositor sent, so the app may keep running with a divergent stream.
        eprintln!("[proxy:wayland] dropped a {dropped} byte backlog for fd {fd}: stream desynced");
        clear_first_cursor_enter_watchers_for_fd(fd);
        if let Some(m) = CONNS.get()
            && let Ok(mut map) = m.lock()
            && let Some(conn) = map.get_mut(&fd)
        {
            conn.reset_tracking();
        }
        let PendingControl { bytes: _, fds } = pending_ctrl;
        return Some(Filtered {
            data: Vec::new(),
            cmsg: Vec::new(),
            fds_to_close: fds,
        });
    }

    if !had_complete_msgs {
        if pending_ctrl.bytes.is_empty() && pending_ctrl.fds.is_empty() {
            return Some(Filtered {
                data: Vec::new(),
                cmsg: Vec::new(),
                fds_to_close: Vec::new(),
            });
        }

        if let Some(m) = ctrl_storage.get()
            && let Ok(mut ctrl_map) = m.lock()
        {
            ctrl_map.insert(fd, pending_ctrl);
            return Some(Filtered {
                data: Vec::new(),
                cmsg: Vec::new(),
                fds_to_close: Vec::new(),
            });
        }

        let PendingControl { bytes, fds } = pending_ctrl;
        return Some(Filtered {
            data: chunk.to_vec(),
            cmsg: bytes,
            fds_to_close: fds,
        });
    }

    if out.is_empty() {
        let PendingControl { bytes: _, fds } = pending_ctrl;
        return Some(Filtered {
            data: Vec::new(),
            cmsg: Vec::new(),
            fds_to_close: fds,
        });
    }

    let PendingControl { bytes, fds } = pending_ctrl;
    Some(Filtered {
        data: out,
        cmsg: bytes,
        fds_to_close: fds,
    })
}

#[cfg(test)]
mod tests {
    use std::os::fd::{AsRawFd, RawFd};
    use std::os::unix::net::UnixStream;

    use super::super::test_support::message_bytes;
    use super::*;

    /// A connection whose fd is a real socket, with private filter state.
    ///
    /// The filter keys every buffer and cache by fd, so each test needs an fd
    /// nothing else uses plus empty state. A socketpair is used instead of an
    /// invented fd number so the fds flowing through the pipeline are valid.
    struct Conn {
        stream: UnixStream,
        /// Kept open so the peer never disappears mid-test.
        _peer: UnixStream,
    }

    impl Conn {
        fn new() -> Self {
            // Production creates these in `init_state`; create them here so the
            // filter takes its stateful path instead of passing chunks through.
            RX_BUFS.get_or_init(Default::default);
            TX_BUFS.get_or_init(Default::default);
            RX_PENDING_CTRL.get_or_init(Default::default);
            TX_PENDING_CTRL.get_or_init(Default::default);
            CONNS.get_or_init(Default::default);

            let (stream, peer) = UnixStream::pair().expect("socketpair");
            let conn = Self {
                stream,
                _peer: peer,
            };
            conn.forget();
            conn
        }

        fn fd(&self) -> RawFd {
            self.stream.as_raw_fd()
        }

        /// Drop state left behind for this fd, before and after the test.
        fn forget(&self) {
            let fd = self.fd();
            for map in [RX_BUFS.get(), TX_BUFS.get()].into_iter().flatten() {
                map.lock().unwrap().remove(&fd);
            }
            for map in [RX_PENDING_CTRL.get(), TX_PENDING_CTRL.get()]
                .into_iter()
                .flatten()
            {
                map.lock().unwrap().remove(&fd);
            }
            if let Some(conns) = CONNS.get() {
                conns.lock().unwrap().remove(&fd);
            }
        }

        /// Register a connection so the interception rules run for this fd.
        fn register(&self) {
            CONNS
                .get()
                .expect("initialised")
                .lock()
                .unwrap()
                .insert(self.fd(), WaylandConn::new());
        }

        fn take(&self, dir: Direction, chunk: &[u8]) -> Filtered {
            filter(self.fd(), dir, chunk, None).expect("the filter always answers")
        }

        fn take_with_cmsg(&self, dir: Direction, chunk: &[u8], cmsg: Cmsg) -> Filtered {
            filter(self.fd(), dir, chunk, Some(cmsg)).expect("the filter always answers")
        }

        /// Run `check` against the connection state kept for this fd.
        fn with_conn<T>(&self, check: impl FnOnce(&WaylandConn) -> T) -> T {
            let conns = CONNS.get().expect("initialised");
            let guard = conns.lock().unwrap();
            check(guard.get(&self.fd()).expect("a connection is registered"))
        }
    }

    impl Drop for Conn {
        fn drop(&mut self) {
            self.forget();
        }
    }

    #[test]
    fn complete_messages_round_trip_byte_for_byte() {
        init_state();
        let conn = Conn::new();

        let first = message_bytes(3, 1, &[1, 2, 3, 4]);
        let second = message_bytes(4, 2, &[9; 8]);
        let stream: Vec<u8> = [first.as_slice(), second.as_slice()].concat();

        // Delivered in awkward pieces, as a real socket would.
        let a = conn.take(Direction::Outbound, &stream[..5]);
        let b = conn.take(Direction::Outbound, &stream[5..11]);
        let c = conn.take(Direction::Outbound, &stream[11..]);

        assert!(a.data.is_empty(), "a partial header forwards nothing");
        assert!(b.data.is_empty(), "still incomplete");
        assert_eq!(c.data, stream, "the whole stream comes back unchanged");
    }

    #[test]
    fn the_two_directions_buffer_independently() {
        init_state();
        let conn = Conn::new();

        let request = message_bytes(3, 1, &[1, 2, 3, 4]);
        let event = message_bytes(1, 0, &[5, 6, 7, 8]);

        let partial = conn.take(Direction::Outbound, &request[..6]);
        assert!(partial.data.is_empty());

        // An event on the same fd must not flush the request buffer.
        let other = conn.take(Direction::Inbound, &event);
        assert_eq!(other.data, event, "the event is forwarded on its own");

        let rest = conn.take(Direction::Outbound, &request[6..]);
        assert_eq!(
            [partial.data, rest.data].concat(),
            request,
            "the request reassembles afterwards"
        );
    }

    #[test]
    fn control_data_waits_for_its_message() {
        init_state();
        let conn = Conn::new();
        let payload = message_bytes(3, 1, &[1, 2, 3, 4]);
        let (raw, _peer) = std::os::unix::net::UnixStream::pair().expect("socketpair");

        // The cmsg arrives on a recvmsg boundary that holds only half a message.
        let held = conn.take_with_cmsg(
            Direction::Inbound,
            &payload[..6],
            Cmsg {
                bytes: vec![0xAA, 0xBB],
                fds: vec![raw.as_raw_fd()],
            },
        );
        assert!(held.data.is_empty());
        assert!(held.cmsg.is_empty(), "control data must not run ahead");
        assert!(
            held.fds_to_close.is_empty(),
            "and the fd is not dropped yet"
        );

        let done = conn.take(Direction::Inbound, &payload[6..]);
        assert_eq!(done.data, payload);
        assert_eq!(done.cmsg, vec![0xAA, 0xBB], "the control data follows it");
        assert_eq!(
            done.fds_to_close,
            vec![raw.as_raw_fd()],
            "the fd is handed back for the caller to close"
        );
    }

    #[test]
    fn intercepted_events_are_swallowed_by_the_pipeline() {
        init_state();
        let conn = Conn::new();
        conn.register();

        // `delete_id` for an id the proxy has not stolen yet: swallowed, and the
        // caller must be able to see that the id went into the pool.
        let stolen = conn.take(
            Direction::Inbound,
            &message_bytes(1, codec::EVT_DELETE_ID, &500u32.to_ne_bytes()),
        );
        assert!(stolen.data.is_empty(), "the event is not forwarded");
        assert_eq!(conn.with_conn(|c| c.stolen_ids.clone()), vec![500]);

        // Everything else still goes through.
        let normal = message_bytes(3, 1, &[1, 2, 3, 4]);
        assert_eq!(conn.take(Direction::Inbound, &normal).data, normal);
    }

    #[test]
    fn what_the_codec_decodes_is_what_gets_forwarded() {
        init_state();
        let conn = Conn::new();
        conn.register();

        let bytes = message_bytes(7, 3, &[1, 2, 3, 4]);
        let (decoded, consumed) = codec::decode(&bytes);

        // The filter forwards `raw()`, so this is the invariant it relies on.
        assert_eq!(consumed, bytes.len());
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0].object_id, 7);
        assert_eq!(decoded[0].opcode, 3);
        assert_eq!(decoded[0].raw(), bytes.as_slice());
        assert_eq!(conn.take(Direction::Outbound, &bytes).data, bytes);
    }

    #[test]
    fn an_overlong_backlog_is_dropped_so_the_stream_resyncs() {
        init_state();
        let conn = Conn::new();
        // Registered so the resync has connection state to abandon.
        conn.register();

        // Seed that state, so the reset below is observable rather than assumed.
        conn.take(
            Direction::Inbound,
            &message_bytes(1, codec::EVT_DELETE_ID, &500u32.to_ne_bytes()),
        );
        assert_eq!(conn.with_conn(|c| c.stolen_ids.clone()), vec![500]);

        // Garbage that never parses: it stays in the reassembly buffer.
        let garbage = vec![0u8; (4 << 20) + 16];
        let flooded = conn.take(Direction::Inbound, &garbage);
        assert!(flooded.data.is_empty(), "nothing is forwarded while lost");
        assert!(
            conn.with_conn(|c| c.stolen_ids.is_empty()),
            "the desynced stream abandons the ids it had stolen"
        );

        // The backlog was released instead of growing further.
        let backlog = RX_BUFS
            .get()
            .expect("initialised")
            .lock()
            .unwrap()
            .get(&conn.fd())
            .map_or(0, Vec::len);
        assert_eq!(backlog, 0, "the backlog is released");

        // And the stream works again straight away.
        let next = message_bytes(3, 1, &[1, 2, 3, 4]);
        assert_eq!(conn.take(Direction::Inbound, &next).data, next);
    }

    #[test]
    fn a_padded_message_round_trips_through_the_filter() {
        init_state();
        let conn = Conn::new();

        // Three argument bytes, so the encoder has to pad to 12. The wire-format
        // invariants themselves are asserted in `test_support`.
        let padded = message_bytes(3, 1, &[1, 2, 3]);

        assert_eq!(
            conn.take(Direction::Outbound, &padded).data,
            padded,
            "a padded message still round-trips"
        );
    }
}
