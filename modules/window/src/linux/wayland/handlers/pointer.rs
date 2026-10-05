//! Pointer events: enter/leave focus tracking and button press capture.

use super::super::codec::{BTN_PRESSED, EVT_BUTTON, EVT_ENTER, EVT_LEAVE, WlMessage};
use super::super::state::WaylandConn;
use super::{Action, Effects};

pub(crate) fn on_pointer_event(
    conn: &mut WaylandConn,
    msg: &WlMessage,
    fx: &mut Effects,
) -> Action {
    match msg.opcode {
        EVT_ENTER => {
            if let (Some(surf_id), Some(x), Some(y)) =
                (msg.u32_arg(12), msg.fixed_arg(16), msg.fixed_arg(20))
            {
                conn.pointer_focus.insert(msg.object_id, surf_id);
                fx.entered = Some((surf_id, x, y));
            }
        }
        EVT_LEAVE => {
            conn.pointer_focus.remove(&msg.object_id);
        }
        EVT_BUTTON => {
            let serial = msg.u32_arg(8);
            let state = msg.u32_arg(20);
            if let (Some(serial), Some(BTN_PRESSED)) = (serial, state) {
                let surf_id = conn.pointer_focus.get(&msg.object_id).copied();
                let seat_id = conn.pointer_seat.get(&msg.object_id).copied();
                if let (Some(surf_id), Some(seat_id)) = (surf_id, seat_id) {
                    fx.button = Some((seat_id, serial, surf_id));
                }
            }
        }
        _ => {}
    }
    Action::Forward
}
