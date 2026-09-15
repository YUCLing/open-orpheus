//! Button-press tracking: remember the latest press (root window, button,
//! root coordinates) so a synthetic move can synthesize a matching release.

use super::super::codec::*;
use super::super::state::X11Conn;

/// Tracks the latest button press. Returns `true` when the message is a press
/// (core ButtonPress or XI2 ButtonPress).
pub(crate) fn track_button(
    conn: &mut X11Conn,
    evt_code: u8,
    off: usize,
    inspect_len: usize,
) -> bool {
    if evt_code == 4 || evt_code == 5 || evt_code == 6 {
        conn.root_window = r32(&conn.rx_buf[off + 8..off + 12], conn.is_le);
        if evt_code == 4 {
            conn.button = conn.rx_buf[off + 1];
            conn.root_x = r16(&conn.rx_buf[off + 20..off + 22], conn.is_le) as i16;
            conn.root_y = r16(&conn.rx_buf[off + 22..off + 24], conn.is_le) as i16;
            return true;
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
                return true;
            }
        }
    }
    false
}

/// Tracks an XI2 `XI_TouchBegin` (touch equivalent of a press). Returns `true`
/// when the message starts a touch sequence, so the caller can capture its
/// bytes for a later synthetic `XI_TouchEnd`.
pub(crate) fn track_touch_begin(
    conn: &mut X11Conn,
    evt_code: u8,
    off: usize,
    inspect_len: usize,
) -> bool {
    if evt_code == XI_GENERIC_EVENT && inspect_len >= 40 {
        let evtype = r16(&conn.rx_buf[off + 8..off + 10], conn.is_le);
        if evtype == XI_EV_TOUCH_BEGIN {
            // xXIDeviceEvent wire offsets (0-based, incl. 32-byte header):
            // detail(touch id)@16, root@20, root_x@32, root_y@36.
            conn.root_window = r32(&conn.rx_buf[off + 20..off + 24], conn.is_le);
            let rx_fp = r32(&conn.rx_buf[off + 32..off + 36], conn.is_le) as i32;
            let ry_fp = r32(&conn.rx_buf[off + 36..off + 40], conn.is_le) as i32;
            conn.root_x = (rx_fp >> 16) as i16;
            conn.root_y = (ry_fp >> 16) as i16;
            conn.button = 1; // Left Click for the _NET_WM_MOVERESIZE payload
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A connection whose parse buffer holds `buf`.
    fn conn_parsing(le: bool, buf: Vec<u8>) -> X11Conn {
        let mut conn = X11Conn::new();
        conn.is_le = le;
        conn.rx_buf = buf;
        conn
    }

    /// A 32-byte core event with the press fields filled in.
    fn core_event(le: bool, code: u8, detail: u8, root: u32, x: i16, y: i16) -> Vec<u8> {
        let mut buf = vec![0u8; 32];
        buf[0] = code;
        buf[1] = detail;
        write_u32(&mut buf[8..12], root, le);
        write_u16(&mut buf[20..22], x as u16, le);
        write_u16(&mut buf[22..24], y as u16, le);
        buf
    }

    /// A 40-byte XI2 `GenericEvent`: `evtype`, device detail, root window and
    /// root coordinates (16.16 fixed point).
    fn xi2_event(le: bool, evtype: u16, detail: u32, root: u32, x_fp: i32, y_fp: i32) -> Vec<u8> {
        let mut buf = vec![0u8; 40];
        buf[0] = XI_GENERIC_EVENT;
        write_u16(&mut buf[8..10], evtype, le);
        write_u32(&mut buf[16..20], detail, le);
        write_u32(&mut buf[20..24], root, le);
        write_u32(&mut buf[32..36], x_fp as u32, le);
        write_u32(&mut buf[36..40], y_fp as u32, le);
        buf
    }

    #[test]
    fn a_core_button_press_is_remembered() {
        let mut conn = conn_parsing(true, core_event(true, 4, 3, 0x1234, -12, 34));

        assert!(track_button(&mut conn, 4, 0, 32));

        assert_eq!(conn.root_window, 0x1234);
        assert_eq!(conn.button, 3);
        assert_eq!(conn.root_x, -12, "root coordinates are signed");
        assert_eq!(conn.root_y, 34);
    }

    #[test]
    fn other_pointer_events_update_only_the_root_window() {
        for code in [5, 6] {
            let mut conn = conn_parsing(true, core_event(true, code, 3, 0x5678, -1, 2));
            conn.button = 9;
            conn.root_x = 5;
            conn.root_y = 6;

            assert!(!track_button(&mut conn, code, 0, 32), "not a press");

            assert_eq!(conn.root_window, 0x5678);
            assert_eq!(conn.button, 9, "the remembered press is untouched");
            assert_eq!(conn.root_x, 5);
            assert_eq!(conn.root_y, 6);
        }
    }

    #[test]
    fn unrelated_events_change_nothing() {
        let mut conn = conn_parsing(true, core_event(true, 2, 0, 0xDEAD, 7, 8));
        conn.root_window = 0x1111;
        conn.button = 9;

        assert!(!track_button(&mut conn, 2, 0, 32));

        assert_eq!(conn.root_window, 0x1111);
        assert_eq!(conn.button, 9, "the remembered press is untouched");
    }

    #[test]
    fn an_xi2_press_is_remembered_in_fixed_point() {
        let mut conn = conn_parsing(true, xi2_event(true, 4, 3, 0x9999, 64 << 16, -32 << 16));

        assert!(track_button(&mut conn, XI_GENERIC_EVENT, 0, 40));

        assert_eq!(conn.root_window, 0x9999);
        assert_eq!(conn.button, 3);
        assert_eq!(conn.root_x, 64);
        assert_eq!(conn.root_y, -32, "negative coordinates keep their sign");
    }

    #[test]
    fn an_xi2_event_that_is_not_a_press_is_ignored() {
        let mut conn = conn_parsing(true, xi2_event(true, 7, 0, 0x9999, 0, 0));

        assert!(!track_button(&mut conn, XI_GENERIC_EVENT, 0, 40));

        assert_eq!(conn.root_window, 0);
    }

    #[test]
    fn a_truncated_xi2_event_is_not_inspected() {
        // Only the first 32 bytes were parsed, so the XI2 fields cannot be read.
        let buf = xi2_event(true, 4, 3, 0x9999, 0, 0)[..32].to_vec();
        let mut conn = conn_parsing(true, buf);

        assert!(!track_button(&mut conn, XI_GENERIC_EVENT, 0, 32));

        assert_eq!(conn.root_window, 0);
    }

    #[test]
    fn an_xi2_touch_begin_maps_onto_a_left_click() {
        let mut conn = conn_parsing(
            true,
            xi2_event(true, XI_EV_TOUCH_BEGIN, 7, 0x2468, 100 << 16, 200 << 16),
        );

        assert!(track_touch_begin(&mut conn, XI_GENERIC_EVENT, 0, 40));

        assert_eq!(conn.root_window, 0x2468);
        assert_eq!(conn.root_x, 100);
        assert_eq!(conn.root_y, 200);
        assert_eq!(conn.button, 1, "synthesised press uses the left button");
    }

    #[test]
    fn touch_tracking_ignores_everything_else() {
        // A core press is not an XI2 touch...
        let mut conn = conn_parsing(true, core_event(true, 4, 1, 0x1, 0, 0));
        assert!(!track_touch_begin(&mut conn, 4, 0, 32));

        // ...nor is an XI2 press, an XI2 touch end, or a truncated generic event.
        let mut conn = conn_parsing(true, xi2_event(true, 4, 1, 0x1, 0, 0));
        assert!(!track_touch_begin(&mut conn, XI_GENERIC_EVENT, 0, 40));

        let mut conn = conn_parsing(true, xi2_event(true, XI_EV_TOUCH_END, 1, 0x1, 0, 0));
        assert!(!track_touch_begin(&mut conn, XI_GENERIC_EVENT, 0, 40));

        let buf = xi2_event(true, XI_EV_TOUCH_BEGIN, 1, 0x1, 0, 0)[..32].to_vec();
        let mut conn = conn_parsing(true, buf);
        assert!(!track_touch_begin(&mut conn, XI_GENERIC_EVENT, 0, 32));
    }

    #[test]
    fn both_reparsers_honour_a_big_endian_client() {
        let mut conn = conn_parsing(false, core_event(false, 4, 2, 0xABCD, -7, 9));
        assert!(track_button(&mut conn, 4, 0, 32));
        assert_eq!((conn.root_window, conn.button), (0xABCD, 2));
        assert_eq!((conn.root_x, conn.root_y), (-7, 9));

        let mut conn = conn_parsing(
            false,
            xi2_event(false, XI_EV_TOUCH_BEGIN, 1, 0x1234, -5 << 16, 6 << 16),
        );
        assert!(track_touch_begin(&mut conn, XI_GENERIC_EVENT, 0, 40));
        assert_eq!(conn.root_window, 0x1234);
        assert_eq!((conn.root_x, conn.root_y), (-5, 6));
    }

    #[test]
    fn tracking_works_at_an_offset_inside_the_buffer() {
        let mut buf = vec![0xAA; 16];
        buf.extend_from_slice(&core_event(true, 4, 4, 0x77, 11, 12));
        let mut conn = conn_parsing(true, buf);

        assert!(track_button(&mut conn, 4, 16, 32));

        assert_eq!((conn.root_window, conn.button), (0x77, 4));
        assert_eq!((conn.root_x, conn.root_y), (11, 12));
    }
}
