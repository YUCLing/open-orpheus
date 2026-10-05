//! Touch events: capture `wl_touch.down` presses so a drag can be started
//! with the same serial mechanism used for pointer buttons.

use super::super::codec::{EVT_TOUCH_DOWN, WlMessage};
use super::super::state::WaylandConn;
use super::{Action, Effects};

pub(crate) fn on_touch_event(conn: &mut WaylandConn, msg: &WlMessage, fx: &mut Effects) -> Action {
    if msg.opcode == EVT_TOUCH_DOWN {
        // wl_touch.down(serial, time, surface, id, x, y): with message
        // offsets relative to the full 8-byte header, serial@8,
        // surface@16. Mirrors the pointer `enter`/`button` capture: the
        // seat owning the touch object is resolved via `touch_seat`.
        let serial = msg.u32_arg(8);
        let surf_id = msg.u32_arg(16);
        if let (Some(serial), Some(surf_id)) = (serial, surf_id) {
            let seat_id = conn.touch_seat.get(&msg.object_id).copied();
            if let Some(seat_id) = seat_id {
                fx.button = Some((seat_id, serial, surf_id));
            }
        }
    }
    Action::Forward
}
