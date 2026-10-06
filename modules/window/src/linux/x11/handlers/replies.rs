//! Replies to injected requests: drop them and extract the cached value
//! (the `_NET_WM_MOVERESIZE` atom, the SHAPE extension opcode, or a
//! QueryPointer result).

use super::super::codec::*;
use super::super::state::{InjectedType, X11Conn};

/// Handles a reply/error to one of our injected requests.
///
/// `off` is the offset of the message header within `conn.rx_buf`. Returns
/// `true` when the message is a reply to an injected request and must be
/// dropped; extraction happens as a side effect.
pub(crate) fn on_reply(conn: &mut X11Conn, code: u8, seq: u16, off: usize) -> bool {
    let Some(inj_type) = conn.injected_seqs.remove(&seq) else {
        return false;
    };

    if code == 1 {
        // Every InternAtom reply carries the atom in the same word.
        let atom = || r32(&conn.rx_buf[off + 8..off + 12], conn.is_le);
        match inj_type {
            InjectedType::InternAtomNetWmMoveresize => {
                conn.net_wm_moveresize = Some(atom());
            }
            InjectedType::InternAtomNetWmWindowType => {
                conn.net_wm.window_type = Some(atom());
            }
            InjectedType::InternAtomNetWmWindowTypeDesktop => {
                conn.net_wm.window_type_desktop = Some(atom());
            }
            InjectedType::InternAtomNetWmState => {
                conn.net_wm.state = Some(atom());
            }
            InjectedType::InternAtomNetWmStateBelow => {
                conn.net_wm.state_below = Some(atom());
            }
            InjectedType::QueryExtensionShape => {
                let present = conn.rx_buf[off + 8] != 0;
                if present {
                    conn.shape_opcode = Some(conn.rx_buf[off + 9]);
                }
            }
            InjectedType::QueryExtensionXInput => {
                let present = conn.rx_buf[off + 8] != 0;
                if present {
                    conn.xi_opcode = Some(conn.rx_buf[off + 9]);
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

    true
}
