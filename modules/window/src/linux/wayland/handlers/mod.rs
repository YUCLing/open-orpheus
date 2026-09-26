//! Wayland functionality: the interception/injection rules.
//!
//! Each rule lives in its own submodule and is a small function of
//! `(&mut WaylandConn, &WlMessage)` returning an [`Action`]. The dispatch
//! tables below are the single index of every intercept point.

mod layer_shell;
mod objects;
mod pointer;
mod title;
mod touch;

use std::os::fd::RawFd;

use super::codec::{
    EVT_DELETE_ID, EVT_GLOBAL, EVT_GLOBAL_REMOVE, Iface, REQ_BIND, REQ_CREATE_SURFACE, REQ_DESTROY,
    REQ_GET_POINTER, REQ_GET_REGISTRY, REQ_GET_TOPLEVEL, REQ_GET_TOPLEVEL_DECORATION,
    REQ_GET_TOUCH, REQ_GET_XDG_SURFACE, REQ_SET_ICON, REQ_SET_TITLE, WL_POINTER_RELEASE,
    WL_TOUCH_RELEASE, WlMessage,
};
use super::state::WaylandConn;

/// What to do with a message after its handler ran.
pub(crate) enum Action {
    /// Forward the message unchanged.
    Forward,
    /// Drop the message.
    Suppress,
    /// Emit these messages in the original's place, in order.
    Replace(Vec<Vec<u8>>),
}

/// Side effects a handler wants applied *after* the connection lock is
/// released (global state updates / user callbacks).
#[derive(Default)]
pub(crate) struct Effects {
    pub(crate) button: Option<(u32, u32, u32)>,
    pub(crate) entered: Option<(u32, i32, i32)>,
    pub(crate) arm_watchers_for: Option<u32>,
}

pub(crate) fn dispatch_request(
    fd: RawFd,
    conn: &mut WaylandConn,
    msg: &WlMessage,
    fx: &mut Effects,
) -> Action {
    // A converted window answers to xdg-shell opcodes but must not reach the
    // compositor as xdg-shell.
    if conn.layer_windows.contains_key(&msg.object_id) {
        return layer_shell::on_client_toplevel_request(fd, conn, msg);
    }
    if conn.xdg_to_layer.contains_key(&msg.object_id) {
        return layer_shell::on_client_xdg_surface_request(conn, msg);
    }
    // A decoration object the compositor has no toplevel for.
    if conn.ifaces.get(&msg.object_id) == Some(&Iface::ZxdgToplevelDecoration) {
        return layer_shell::on_decoration_object_request(conn, msg);
    }

    let Some(iface) = conn.ifaces.get(&msg.object_id).copied() else {
        return Action::Forward;
    };

    match (iface, msg.opcode) {
        (Iface::WlDisplay, REQ_GET_REGISTRY) => objects::on_get_registry(conn, msg),
        (Iface::WlRegistry, REQ_BIND) => objects::on_bind(conn, msg),
        (Iface::WlCompositor, REQ_CREATE_SURFACE) => objects::on_create_surface(conn, msg),
        (Iface::WlSeat, REQ_GET_POINTER) => objects::on_get_pointer(conn, msg),
        (Iface::WlSeat, REQ_GET_TOUCH) => objects::on_get_touch(conn, msg),
        (Iface::XdgWmBase, REQ_GET_XDG_SURFACE) => objects::on_get_xdg_surface(conn, msg),
        (Iface::ZxdgDecorationManager, REQ_GET_TOPLEVEL_DECORATION) => {
            layer_shell::on_get_toplevel_decoration(conn, msg)
        }
        (Iface::XdgToplevelIconManager, REQ_SET_ICON) => layer_shell::on_set_icon(conn, msg),
        // The role is assigned here, so this is also where a layer-shell
        // declaration is consumed.
        (Iface::XdgSurface, REQ_GET_TOPLEVEL) => layer_shell::on_get_toplevel(fd, conn, msg, fx),
        (Iface::XdgToplevel, REQ_SET_TITLE) => title::on_set_title(fd, conn, msg),
        (Iface::WlSurface | Iface::XdgSurface | Iface::XdgToplevel, REQ_DESTROY) => {
            objects::on_destroy(fd, conn, msg)
        }
        (Iface::WlPointer, WL_POINTER_RELEASE) => objects::on_pointer_release(conn, msg),
        (Iface::WlTouch, WL_TOUCH_RELEASE) => objects::on_touch_release(conn, msg),
        _ => Action::Forward,
    }
}

pub(crate) fn dispatch_event(conn: &mut WaylandConn, msg: &WlMessage, fx: &mut Effects) -> Action {
    if msg.object_id == 1 && msg.opcode == EVT_DELETE_ID {
        return objects::on_delete_id(conn, msg);
    }

    // Events for objects the proxy created for itself are not the client's
    // business (a reserved id answers with a callback `done`).
    if conn.injected_ids.contains(&msg.object_id) {
        return Action::Suppress;
    }

    if conn.ifaces.get(&msg.object_id) == Some(&Iface::WlRegistry) {
        return match msg.opcode {
            EVT_GLOBAL => layer_shell::on_registry_global(conn, msg),
            EVT_GLOBAL_REMOVE => layer_shell::on_registry_global_remove(conn, msg),
            _ => Action::Forward,
        };
    }

    if conn.layer_windows.contains_key(&msg.object_id) {
        return layer_shell::on_layer_event(conn, msg);
    }

    if conn.ifaces.get(&msg.object_id) == Some(&Iface::WlPointer) {
        return pointer::on_pointer_event(conn, msg, fx);
    }

    if conn.ifaces.get(&msg.object_id) == Some(&Iface::WlTouch) {
        return touch::on_touch_event(conn, msg, fx);
    }

    Action::Forward
}

#[cfg(test)]
mod tests {
    use super::super::codec::{
        BTN_PRESSED, CUSTOM_ID_PREFIX, EVT_BUTTON, EVT_ENTER, EVT_LEAVE, EVT_TOUCH_DOWN,
    };
    use super::super::state::{CUSTOM_ID_MAP, WaylandConn, init_state};
    use super::super::test_support::{message, wl_string, word};
    use super::*;

    const FD: RawFd = 42;

    /// `wl_registry.bind(name, interface, version, id)`.
    fn bind_message(registry: u32, interface: &str, new_id: u32) -> WlMessage {
        let mut args = word(1);
        args.extend_from_slice(&wl_string(interface));
        args.extend_from_slice(&word(1));
        args.extend_from_slice(&word(new_id));
        message(registry, REQ_BIND, &args)
    }

    #[test]
    fn unknown_objects_and_opcodes_are_forwarded() {
        let mut conn = WaylandConn::new();
        let mut fx = Effects::default();

        let unknown = message(99, 0, &word(1));
        assert!(matches!(
            dispatch_request(FD, &mut conn, &unknown, &mut fx),
            Action::Forward
        ));
        assert!(matches!(
            dispatch_event(&mut conn, &unknown, &mut fx),
            Action::Forward
        ));

        // The display is known, but this opcode is not intercepted.
        let unrelated = message(1, 99, &word(1));
        assert!(matches!(
            dispatch_request(FD, &mut conn, &unrelated, &mut fx),
            Action::Forward
        ));
        assert!(fx.button.is_none() && fx.entered.is_none());
    }

    #[test]
    fn registry_binds_are_tracked() {
        let mut conn = WaylandConn::new();
        let mut fx = Effects::default();

        // The client first turns the display into a registry object...
        dispatch_request(
            FD,
            &mut conn,
            &message(1, REQ_GET_REGISTRY, &word(9)),
            &mut fx,
        );
        assert_eq!(conn.ifaces.get(&9), Some(&Iface::WlRegistry));

        // ...and then binds interfaces on it.
        dispatch_request(FD, &mut conn, &bind_message(9, "wl_compositor", 2), &mut fx);
        assert_eq!(conn.ifaces.get(&2), Some(&Iface::WlCompositor));
        assert_eq!(conn.compositor_id, Some(2));

        dispatch_request(FD, &mut conn, &bind_message(9, "wl_seat", 3), &mut fx);
        assert_eq!(conn.ifaces.get(&3), Some(&Iface::WlSeat));

        dispatch_request(FD, &mut conn, &bind_message(9, "xdg_wm_base", 4), &mut fx);
        assert_eq!(conn.ifaces.get(&4), Some(&Iface::XdgWmBase));

        // Unknown interfaces are forwarded without being tagged.
        dispatch_request(FD, &mut conn, &bind_message(9, "wl_shm", 5), &mut fx);
        assert!(!conn.ifaces.contains_key(&5));
    }

    #[test]
    fn device_creation_records_the_owning_seat() {
        let mut conn = WaylandConn::new();
        let mut fx = Effects::default();
        conn.ifaces.insert(3, Iface::WlSeat);

        dispatch_request(
            FD,
            &mut conn,
            &message(3, REQ_GET_POINTER, &word(6)),
            &mut fx,
        );
        assert_eq!(conn.ifaces.get(&6), Some(&Iface::WlPointer));
        assert_eq!(conn.pointer_seat.get(&6), Some(&3));

        dispatch_request(FD, &mut conn, &message(3, REQ_GET_TOUCH, &word(7)), &mut fx);
        assert_eq!(conn.ifaces.get(&7), Some(&Iface::WlTouch));
        assert_eq!(conn.touch_seat.get(&7), Some(&3));
    }

    #[test]
    fn window_object_creation_links_the_whole_chain() {
        let mut conn = WaylandConn::new();
        let mut fx = Effects::default();
        conn.ifaces.insert(2, Iface::WlCompositor);
        conn.ifaces.insert(4, Iface::XdgWmBase);

        dispatch_request(
            FD,
            &mut conn,
            &message(2, REQ_CREATE_SURFACE, &word(10)),
            &mut fx,
        );
        assert_eq!(conn.ifaces.get(&10), Some(&Iface::WlSurface));

        // xdg_wm_base.get_xdg_surface(new_id, surface)
        let mut args = word(20);
        args.extend_from_slice(&word(10));
        dispatch_request(
            FD,
            &mut conn,
            &message(4, REQ_GET_XDG_SURFACE, &args),
            &mut fx,
        );
        assert_eq!(conn.ifaces.get(&20), Some(&Iface::XdgSurface));
        assert_eq!(conn.xdg_to_wl.get(&20), Some(&10));

        dispatch_request(
            FD,
            &mut conn,
            &message(20, REQ_GET_TOPLEVEL, &word(30)),
            &mut fx,
        );
        assert_eq!(conn.ifaces.get(&30), Some(&Iface::XdgToplevel));
        assert_eq!(conn.top_to_xdg.get(&30), Some(&20));
        assert_eq!(conn.wl_to_top.get(&10), Some(&30));
        assert_eq!(fx.arm_watchers_for, Some(10), "cursor watchers arm on bind");
    }

    #[test]
    fn a_custom_title_is_swallowed() {
        init_state();
        let mut conn = WaylandConn::new();
        conn.ifaces.insert(30, Iface::XdgToplevel);
        conn.top_to_xdg.insert(30, 20);
        conn.xdg_to_wl.insert(20, 10);

        let mut args = wl_string("normal title");
        args.extend_from_slice(&[0, 0, 0, 0]);
        assert!(matches!(
            dispatch_request(
                FD,
                &mut conn,
                &message(30, REQ_SET_TITLE, &args),
                &mut Effects::default()
            ),
            Action::Forward
        ));

        let secret = "window-42";
        let mut args = wl_string(&format!("{CUSTOM_ID_PREFIX}{secret}"));
        args.extend_from_slice(&[0, 0, 0, 0]);
        assert!(matches!(
            dispatch_request(
                FD,
                &mut conn,
                &message(30, REQ_SET_TITLE, &args),
                &mut Effects::default()
            ),
            Action::Suppress
        ));

        let map = CUSTOM_ID_MAP.get().expect("initialised").lock().unwrap();
        assert_eq!(map.get(secret).copied(), Some((FD, 10)));
    }

    #[test]
    fn pointer_events_track_focus_and_buttons() {
        let mut conn = WaylandConn::new();
        conn.ifaces.insert(6, Iface::WlPointer);
        conn.pointer_seat.insert(6, 3);
        let mut fx = Effects::default();

        // enter(serial, surface, x, y)
        let mut args = word(11);
        args.extend_from_slice(&word(10));
        args.extend_from_slice(&(64i32 << 8).to_ne_bytes());
        args.extend_from_slice(&(-32i32 << 8).to_ne_bytes());
        dispatch_event(&mut conn, &message(6, EVT_ENTER, &args), &mut fx);
        assert_eq!(conn.pointer_focus.get(&6), Some(&10));
        assert_eq!(fx.entered, Some((10, 64, -32)));

        // button(serial, time, button, state) with the pressed state
        let mut fx = Effects::default();
        let mut args = word(77);
        args.extend_from_slice(&word(1_000));
        args.extend_from_slice(&word(0x110));
        args.extend_from_slice(&word(BTN_PRESSED));
        dispatch_event(&mut conn, &message(6, EVT_BUTTON, &args), &mut fx);
        assert_eq!(fx.button, Some((3, 77, 10)));

        // A release does not start a drag.
        let mut fx = Effects::default();
        let mut args = word(78);
        args.extend_from_slice(&word(1_001));
        args.extend_from_slice(&word(0x110));
        args.extend_from_slice(&word(0));
        dispatch_event(&mut conn, &message(6, EVT_BUTTON, &args), &mut fx);
        assert_eq!(fx.button, None);

        // leave(serial, surface) clears the focus, so later presses do nothing.
        let mut args = word(79);
        args.extend_from_slice(&word(10));
        let mut fx = Effects::default();
        dispatch_event(&mut conn, &message(6, EVT_LEAVE, &args), &mut fx);
        assert!(!conn.pointer_focus.contains_key(&6));

        let mut fx = Effects::default();
        let mut args = word(80);
        args.extend_from_slice(&word(1_002));
        args.extend_from_slice(&word(0x110));
        args.extend_from_slice(&word(BTN_PRESSED));
        dispatch_event(&mut conn, &message(6, EVT_BUTTON, &args), &mut fx);
        assert_eq!(fx.button, None, "no surface is focused any more");
    }

    #[test]
    fn touch_downs_are_captured_for_the_owning_seat() {
        let mut conn = WaylandConn::new();
        conn.ifaces.insert(7, Iface::WlTouch);
        conn.touch_seat.insert(7, 3);

        // down(serial, time, surface, id, x, y)
        let mut args = word(21);
        args.extend_from_slice(&word(1_000));
        args.extend_from_slice(&word(10));
        args.extend_from_slice(&word(0));
        args.extend_from_slice(&(16i32 << 8).to_ne_bytes());
        args.extend_from_slice(&(32i32 << 8).to_ne_bytes());
        let mut fx = Effects::default();
        dispatch_event(&mut conn, &message(7, EVT_TOUCH_DOWN, &args), &mut fx);
        assert_eq!(fx.button, Some((3, 21, 10)));

        // Any other touch event (wl_touch.up is opcode 1) is passed through.
        let mut fx = Effects::default();
        dispatch_event(&mut conn, &message(7, 1, &args), &mut fx);
        assert_eq!(fx.button, None);

        // A truncated body yields no capture instead of panicking.
        let mut fx = Effects::default();
        dispatch_event(&mut conn, &message(7, EVT_TOUCH_DOWN, &word(21)), &mut fx);
        assert_eq!(fx.button, None);
    }

    #[test]
    fn releasing_a_device_drops_its_tracking() {
        let mut conn = WaylandConn::new();
        conn.ifaces.insert(7, Iface::WlTouch);
        conn.touch_seat.insert(7, 3);

        dispatch_request(
            FD,
            &mut conn,
            &message(7, WL_TOUCH_RELEASE, &[]),
            &mut Effects::default(),
        );

        assert!(!conn.ifaces.contains_key(&7));
        assert!(!conn.touch_seat.contains_key(&7));
    }

    #[test]
    fn destroyed_ids_are_stolen_up_to_a_limit() {
        let mut conn = WaylandConn::new();

        let mut fx = Effects::default();
        dispatch_event(&mut conn, &message(1, EVT_DELETE_ID, &word(50)), &mut fx);
        assert_eq!(conn.stolen_ids, vec![50]);
        assert!(conn.ifaces.contains_key(&1), "the display is never purged");

        // Fill the pool to the cap.
        for id in 0..31 {
            conn.stolen_ids.push(id);
        }
        assert_eq!(conn.stolen_ids.len(), 32);

        let mut fx = Effects::default();
        dispatch_event(&mut conn, &message(1, EVT_DELETE_ID, &word(60)), &mut fx);
        assert!(
            !conn.stolen_ids.contains(&60),
            "no more stealing once the pool is full"
        );
    }

    #[test]
    fn injected_ids_are_recycled_regardless_of_the_cap() {
        let mut conn = WaylandConn::new();
        for id in 0..32 {
            conn.stolen_ids.push(id);
        }
        conn.injected_ids.insert(300);
        conn.ifaces.insert(300, Iface::WlSurface);

        let mut fx = Effects::default();
        dispatch_event(&mut conn, &message(1, EVT_DELETE_ID, &word(300)), &mut fx);

        assert!(!conn.injected_ids.contains(&300));
        assert!(conn.stolen_ids.contains(&300), "the id returns to the pool");
        assert!(!conn.ifaces.contains_key(&300), "and is purged");
    }
}
