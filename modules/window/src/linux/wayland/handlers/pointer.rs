//! Pointer events: enter/leave focus tracking and button press capture.

use super::super::codec::{
    BTN_PRESSED, BTN_RELEASED, EVT_AXIS, EVT_BUTTON, EVT_ENTER, EVT_LEAVE, EVT_MOTION, WlMessage,
};
use super::super::state::WaylandConn;
use super::{Action, Effects, grab};

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
                // An interactive move or resize may name this serial.
                if let Some(serial) = msg.u32_arg(8) {
                    conn.pointer_enter_serial.insert(surf_id, serial);
                }
                conn.pointer_focus.insert(msg.object_id, surf_id);
                conn.pointer_position.insert(msg.object_id, (x, y));
                fx.entered.push((surf_id, x, y));
            }
        }
        EVT_LEAVE => {
            if let Some(surf_id) = conn.pointer_focus.remove(&msg.object_id) {
                grab::on_surface_left(conn, fx, surf_id);
            }
            conn.pointer_position.remove(&msg.object_id);
        }
        EVT_MOTION => {
            if let (Some(x), Some(y)) = (msg.fixed_f64(12), msg.fixed_f64(16)) {
                conn.pointer_position
                    .insert(msg.object_id, (x as i32, y as i32));
                grab::on_motion(conn, fx, msg.object_id, x, y);
            }
        }
        EVT_AXIS => {
            if let (Some(wl_surface_id), Some(axis)) = (
                conn.pointer_focus.get(&msg.object_id).copied(),
                msg.u32_arg(12),
            ) {
                fx.pointer_axes.push((wl_surface_id, axis));
            }
        }
        EVT_BUTTON => {
            let serial = msg.u32_arg(8);
            // `serial, time, button, state`; a code of zero is not one.
            let button = msg.u32_arg(16).filter(|code| *code != 0);
            let state = msg.u32_arg(20);
            if let (Some(serial), Some(BTN_PRESSED)) = (serial, state) {
                let surf_id = conn.pointer_focus.get(&msg.object_id).copied();
                let seat_id = conn.pointer_seat.get(&msg.object_id).copied();
                let position = conn.pointer_position.get(&msg.object_id).copied();
                if let (Some(surf_id), Some(seat_id), Some((x, y))) = (surf_id, seat_id, position) {
                    fx.button = Some((seat_id, serial, surf_id, x, y, button.unwrap_or(0)));
                }
            } else if let Some(BTN_RELEASED) = state {
                // Which button came up decides whether a gesture is over: see
                // `grab::on_pointer_button_release`.
                grab::on_pointer_button_release(conn, msg.object_id, button);
            }
        }
        _ => {}
    }
    Action::Forward
}

#[cfg(test)]
mod tests {
    use super::super::super::test_support::{message, word};
    use super::*;

    #[test]
    fn left_and_right_clicks_both_capture_the_parent_relative_anchor() {
        const LEFT_BUTTON: u32 = 0x110;
        const RIGHT_BUTTON: u32 = 0x111;
        for button in [LEFT_BUTTON, RIGHT_BUTTON] {
            let mut conn = WaylandConn::new();
            conn.pointer_seat.insert(30, 2);
            conn.pointer_focus.insert(30, 10);
            conn.pointer_position.insert(30, (173, 241));
            let mut fx = Effects::default();
            let pressed = message(
                30,
                EVT_BUTTON,
                &[word(99), word(100), word(button), word(BTN_PRESSED)].concat(),
            );
            assert!(matches!(
                on_pointer_event(&mut conn, &pressed, &mut fx),
                Action::Forward
            ));
            assert_eq!(fx.button, Some((2, 99, 10, 173, 241, button)));
        }
    }
}
