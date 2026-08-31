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

    let (msgs, sync_lost, mut pending_ctrl) = {
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
        if sync_lost {
            buf.clear();
        }

        let mut pending_ctrl = PendingControl::default();
        if let Some(m) = ctrl_storage.get()
            && let Ok(mut ctrl_map) = m.lock()
            && let Some(stored) = ctrl_map.remove(&fd)
        {
            pending_ctrl = stored;
        }

        (msgs, sync_lost, pending_ctrl)
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
                Action::Replace(bytes) => out.extend_from_slice(&bytes),
            }
        }
    }

    // Apply side effects after releasing the connection lock.
    if let Some((seat_id, serial, surf_id, x, y)) = fx.button
        && let Some(m) = LAST_BUTTON.get()
        && let Ok(mut opt) = m.lock()
    {
        *opt = Some(LastButton {
            fd,
            seat_id,
            serial,
            wl_surface_id: surf_id,
            x,
            y,
        });
    }
    if let Some((wl_surface_id, x, y)) = fx.entered {
        fire_first_cursor_enter_watchers(fd, wl_surface_id, x, y);
    }
    if let Some(wl_surface_id) = fx.arm_watchers_for {
        arm_first_cursor_enter_watchers(fd, wl_surface_id);
    }
    if fx.pointer_axis {
        fire_next_pointer_axis(fd);
    }

    // ── Ancillary data + output assembly (unchanged semantics) ──
    pending_ctrl.bytes.extend_from_slice(&new_ctrl_bytes);
    pending_ctrl.fds.extend(new_ctrl_fds);

    if sync_lost {
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
