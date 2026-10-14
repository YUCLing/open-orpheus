//! xdg-shell shadowing: the traffic of a window the compositor only knows as a
//! layer surface.
//!
//! A converted window's client keeps speaking xdg-shell, so these handlers
//! translate or drop what follows the conversion: toplevel requests never reach
//! the compositor, `xdg_surface` requests are rewritten onto the layer object,
//! layer events are synthesised back into the xdg-shell shape, and decoration
//! or icon traffic for a window with no `xdg_toplevel` is answered client-side
//! or dropped instead of being forwarded. Nothing here binds a global or
//! decides a role; that is [`super::conversion`]'s job.

use std::os::fd::RawFd;

use super::super::codec::{
    DECORATION_CLIENT_SIDE, EVT_LAYER_CLOSED, EVT_LAYER_CONFIGURE, Iface, REQ_ACK_CONFIGURE,
    REQ_DECORATION_DESTROY, REQ_DESTROY, REQ_GET_POPUP, REQ_GET_TOPLEVEL, REQ_MOVE, REQ_RESIZE,
    REQ_SET_TITLE, REQ_SET_WINDOW_GEOMETRY, WlMessage,
};
use super::super::layer_shell;
use super::super::state::WaylandConn;
use super::{Action, Effects, grab};

/// Requests from a client that still believes its window is an `xdg_toplevel`.
///
/// Every one of them is dropped: the compositor only knows the object as a
/// layer surface, so forwarding any xdg-toplevel opcode would be misread as a
/// different layer request (or rejected outright).
pub(crate) fn on_client_toplevel_request(
    fd: RawFd,
    conn: &mut WaylandConn,
    msg: &WlMessage,
    fx: &mut Effects,
) -> Action {
    match msg.opcode {
        REQ_DESTROY => {
            conn.purge(msg.object_id);
            Action::Replace(vec![layer_shell::destroy(msg.object_id)])
        }
        // Layer shell has no move and no interactive resize, so the proxy
        // replays the gesture itself against the surface it converted.
        REQ_MOVE | REQ_RESIZE => grab::begin(fd, conn, msg),
        REQ_SET_TITLE => {
            // The smuggled window id still has to be captured, but a title has
            // no meaning for a layer surface.
            let _ = super::title::on_set_title(conn, msg, fx);
            Action::Suppress
        }
        _ => Action::Suppress,
    }
}

/// Requests from a client on the `xdg_surface` of a converted window.
///
/// The compositor holds a reserved callback under that id, not the xdg_surface
/// the client thinks it has, so nothing about it can be forwarded as written:
/// what it means is translated onto the layer surface instead, and its destroy
/// is left alone because it is already the callback's own.
/// anything that would touch it has to be dropped or translated.
pub(crate) fn on_client_xdg_surface_request(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    match msg.opcode {
        REQ_DESTROY => {
            // The id was reserved with a callback the compositor has long since
            // consumed, so there is nothing out there to destroy: the proxy
            // answers for it, and releases it to the client now that the client
            // is done with it.
            on_reserved_id_request(conn, msg)
        }
        REQ_SET_WINDOW_GEOMETRY | REQ_GET_TOPLEVEL => Action::Suppress,
        REQ_ACK_CONFIGURE => {
            let Some(serial) = msg.u32_arg(8) else {
                return Action::Suppress;
            };
            let Some(layer_id) = conn.xdg_to_layer.get(&msg.object_id).copied() else {
                return Action::Suppress;
            };
            Action::Replace(vec![layer_shell::ack_configure(layer_id, serial)])
        }
        REQ_GET_POPUP => {
            let (Some(popup_id), Some(layer_id)) = (
                msg.u32_arg(8),
                conn.xdg_to_layer.get(&msg.object_id).copied(),
            ) else {
                return Action::Suppress;
            };
            // The layer surface has to be the popup's parent, which means
            // creating it with a null xdg parent first.
            let Some(rewritten) = layer_shell::strip_popup_parent(msg.raw()) else {
                return Action::Suppress;
            };
            Action::Replace(vec![rewritten, layer_shell::get_popup(layer_id, popup_id)])
        }
        _ => Action::Forward,
    }
}

/// Requests from a client on an id the compositor never created an object for,
/// and whose callback has already answered and been consumed.
///
/// Nothing may be forwarded — there is no object to name — and the object is
/// not the client's to destroy in any case. The client is told the id is free
/// when it lets its own object go, which is the only moment libwayland is
/// willing to reuse it.
pub(crate) fn on_reserved_id_request(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    if msg.opcode == REQ_DESTROY {
        let id = msg.object_id;
        // Every table that answered for the client's object goes with it, or a
        // later object under the same id would be misread.
        conn.ifaces.remove(&id);
        conn.xdg_to_wl.remove(&id);
        // Except the layer surface that stands in for a converted window: it is
        // destroyed by the toplevel's own destroy, which the client sends first
        // but is not obliged to.
        conn.xdg_to_layer.remove(&id);

        // The callback that reserved the id is the compositor's to finish with,
        // and it may not have answered yet. Its own `delete_id` is passed on to
        // the client as the release when it arrives; if it already has, that
        // answer was held back and the client is told now.
        let Some(reservation) = conn.reservations.get_mut(&id) else {
            return Action::Suppress;
        };
        reservation.client_done = true;
        if reservation.callback_done {
            conn.reservations.remove(&id);
            conn.pending_to_client.push(layer_shell::delete_id(id));
        }
        // The callback's events stay hidden either way, until it has answered.
    }
    Action::Suppress
}

/// Events the compositor sends for a layer surface.
pub(crate) fn on_layer_event(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    match msg.opcode {
        EVT_LAYER_CONFIGURE => {
            // configure(serial, width, height) has to reach the client in the
            // xdg-shell shape it is waiting for.
            let (Some(serial), Some(width), Some(height)) =
                (msg.u32_arg(8), msg.u32_arg(12), msg.u32_arg(16))
            else {
                return Action::Suppress;
            };
            let Some(layer) = conn.layer_windows.get(&msg.object_id) else {
                return Action::Suppress;
            };
            Action::Replace(vec![
                layer_shell::xdg_toplevel_configure(msg.object_id, width as i32, height as i32),
                layer_shell::xdg_surface_configure(layer.xdg_surface, serial),
            ])
        }
        EVT_LAYER_CLOSED => Action::Replace(vec![layer_shell::xdg_toplevel_close(msg.object_id)]),
        _ => Action::Forward,
    }
}

/// `zxdg_decoration_manager_v1.get_toplevel_decoration` for a converted window.
///
/// The compositor has no toplevel to decorate, and would answer the request
/// with a protocol error, so the client is given client-side decorations
/// directly. The decoration object is tracked because the client will keep
/// sending requests on it.
pub(crate) fn on_get_toplevel_decoration(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    let (Some(decoration_id), Some(toplevel_id)) = (msg.u32_arg(8), msg.u32_arg(12)) else {
        return Action::Suppress;
    };
    if !conn.layer_windows.contains_key(&toplevel_id)
        && conn.ifaces.get(&toplevel_id) != Some(&Iface::XdgPopupShim)
        && !conn.reservations.contains_key(&toplevel_id)
    {
        return Action::Forward;
    }

    conn.ifaces
        .insert(decoration_id, Iface::ZxdgToplevelDecoration);
    conn.injected_ids.insert(decoration_id);
    conn.pending_to_client
        .push(layer_shell::decoration_configure(
            decoration_id,
            DECORATION_CLIENT_SIDE,
        ));
    // Reserve the id on the compositor: a suppressed `new_id` otherwise leaves
    // a hole in its object map at the edge it is still growing, and the next id
    // the client allocates is refused.
    Action::Replace(vec![layer_shell::sync_callback(decoration_id)])
}

/// `xdg_toplevel_icon_manager_v1.set_icon` for a converted window.
///
/// The argument is typed `xdg_toplevel`, so the compositor refuses it once the
/// window is a layer surface. The icon object itself lives on normally; only
/// the assignment is dropped.
pub(crate) fn on_set_icon(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    match msg.u32_arg(8) {
        Some(toplevel_id)
            if conn.layer_windows.contains_key(&toplevel_id)
                || conn.ifaces.get(&toplevel_id) == Some(&Iface::XdgPopupShim)
                || conn.reservations.contains_key(&toplevel_id) =>
        {
            Action::Suppress
        }
        _ => Action::Forward,
    }
}

/// Requests on a decoration object the compositor never created.
///
/// The id is deliberately not returned to the injected-id pool: the client's
/// object lives on until it destroys it, and handing the id out again would
/// put a compositor-side resource where the client expects its decoration.
pub(crate) fn on_decoration_object_request(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    if msg.opcode == REQ_DECORATION_DESTROY {
        conn.injected_ids.remove(&msg.object_id);
        conn.purge(msg.object_id);
    }
    Action::Suppress
}

#[cfg(test)]
mod tests {
    use super::super::super::codec::{
        DECORATION_CLIENT_SIDE, EVT_DECORATION_CONFIGURE, EVT_LAYER_CLOSED, EVT_LAYER_CONFIGURE,
        EVT_TOPLEVEL_CLOSE, EVT_TOPLEVEL_CONFIGURE, REQ_ACK_CONFIGURE, REQ_DECORATION_DESTROY,
        REQ_DESTROY, REQ_GET_POPUP, REQ_GET_TOPLEVEL_DECORATION, REQ_LAYER_ACK_CONFIGURE,
        REQ_LAYER_DESTROY, REQ_LAYER_GET_POPUP, REQ_MOVE, REQ_SET_ICON, REQ_SET_TITLE,
        REQ_SET_WINDOW_GEOMETRY, decorate_title,
    };
    use super::super::super::test_support::{
        fixture, header, message, options, replaced, u32_at, wl_string, word,
    };
    use super::super::conversion;
    use super::*;

    /// A connection of this test module's own: none of these cases reads the
    /// press registry the gesture validation consults.
    const FD: RawFd = 42;

    /// Convert window 30 the way `flush_role` would, for the tests that only
    /// need a converted window to exist.
    fn convert(conn: &mut WaylandConn) -> Vec<Vec<u8>> {
        conversion::convert_to_layer_surface(conn, 20, 10, 30, options(), &mut Effects::default())
            .expect("the conversion is sendable")
    }

    #[test]
    fn client_toplevel_requests_are_never_forwarded() {
        let (_guard, mut conn) = fixture();
        convert(&mut conn);

        // A title is captured and swallowed rather than reaching a surface
        // that has no title.
        let title = decorate_title("layer-window-99", "Real");
        let mut fx = Effects::default();
        let action = on_client_toplevel_request(
            FD,
            &mut conn,
            &message(30, REQ_SET_TITLE, &wl_string(&title)),
            &mut fx,
        );
        assert!(matches!(action, Action::Suppress));
        assert_eq!(
            conn.surface_ids.get(&10).map(String::as_str),
            Some("layer-window-99"),
            "id resolved to the surface"
        );

        // Anything else is dropped too: the compositor only knows a layer
        // surface under this id.
        let action = on_client_toplevel_request(
            FD,
            &mut conn,
            &message(30, REQ_MOVE, &word(1)),
            &mut Effects::default(),
        );
        assert!(matches!(action, Action::Suppress));

        // Destroying the toplevel destroys the layer surface.
        let messages = replaced(on_client_toplevel_request(
            FD,
            &mut conn,
            &message(30, REQ_DESTROY, &[]),
            &mut Effects::default(),
        ));
        assert_eq!(messages.len(), 1);
        assert_eq!(header(&messages[0]), (30, REQ_LAYER_DESTROY, 8));
        assert!(!conn.layer_windows.contains_key(&30));
        assert!(conn.wl_to_layer.is_empty());
    }

    #[test]
    fn xdg_surface_requests_are_translated() {
        let (_guard, mut conn) = fixture();
        convert(&mut conn);

        // The compositor's xdg_surface has no role, so geometry is dropped.
        let action = on_client_xdg_surface_request(
            &mut conn,
            &message(20, REQ_SET_WINDOW_GEOMETRY, &[0, 0, 0, 0, 1, 0, 0, 0]),
        );
        assert!(matches!(action, Action::Suppress));

        // The ack belongs to the layer surface.
        let messages = replaced(on_client_xdg_surface_request(
            &mut conn,
            &message(20, REQ_ACK_CONFIGURE, &word(99)),
        ));
        assert_eq!(messages.len(), 1);
        assert_eq!(header(&messages[0]), (30, REQ_LAYER_ACK_CONFIGURE, 12));
        assert_eq!(u32_at(&messages[0], 8), 99);

        // A popup is created with a null parent, then re-parented to the layer
        // surface.
        let mut body = word(60);
        body.extend_from_slice(&word(20));
        body.extend_from_slice(&word(70));
        let messages = replaced(on_client_xdg_surface_request(
            &mut conn,
            &message(20, REQ_GET_POPUP, &body),
        ));
        assert_eq!(messages.len(), 2);
        assert_eq!(u32_at(&messages[0], 8), 60, "popup id preserved");
        assert_eq!(u32_at(&messages[0], 12), 0, "xdg parent nulled");
        assert_eq!(u32_at(&messages[0], 16), 70, "positioner preserved");
        assert_eq!(header(&messages[1]), (30, REQ_LAYER_GET_POPUP, 12));
        assert_eq!(u32_at(&messages[1], 8), 60);
    }

    #[test]
    fn a_converted_window_answers_for_its_reserved_xdg_surface() {
        let (_guard, mut conn) = fixture();
        convert(&mut conn);

        // Nothing about the id may be forwarded — the compositor has had no
        // object under it since it consumed the callback — so the destroy is
        // answered here. Whether that also releases the id depends on whether
        // the callback has already answered: if it has, this is the release the
        // client is waiting for.
        let action = on_client_xdg_surface_request(&mut conn, &message(20, REQ_DESTROY, &[]));
        assert!(matches!(action, Action::Suppress), "no reservation yet");
        assert!(conn.pending_to_client.is_empty());

        conn.reservations
            .insert(20, crate::linux::wayland::state::Reservation::default());
        conn.reservations.get_mut(&20).unwrap().callback_done = true;
        let action = on_client_xdg_surface_request(&mut conn, &message(20, REQ_DESTROY, &[]));
        assert!(matches!(action, Action::Suppress));
        assert_eq!(conn.pending_to_client.len(), 1);
        assert!(!conn.reservations.contains_key(&20));
    }

    #[test]
    fn layer_events_are_synthesised_as_xdg_events() {
        let (_guard, mut conn) = fixture();
        convert(&mut conn);

        let mut body = word(123);
        body.extend_from_slice(&word(300));
        body.extend_from_slice(&word(200));
        let messages = replaced(on_layer_event(
            &mut conn,
            &message(30, EVT_LAYER_CONFIGURE, &body),
        ));

        assert_eq!(messages.len(), 2);
        assert_eq!(header(&messages[0]), (30, EVT_TOPLEVEL_CONFIGURE, 20));
        assert_eq!(u32_at(&messages[0], 8), 300);
        assert_eq!(u32_at(&messages[0], 12), 200);
        assert_eq!(u32_at(&messages[0], 16), 0, "an empty states array");
        assert_eq!(header(&messages[1]), (20, 0, 12), "xdg_surface.configure");
        assert_eq!(u32_at(&messages[1], 8), 123, "the serial is passed through");

        let messages = replaced(on_layer_event(
            &mut conn,
            &message(30, EVT_LAYER_CLOSED, &[]),
        ));
        assert_eq!(messages.len(), 1);
        assert_eq!(header(&messages[0]), (30, EVT_TOPLEVEL_CLOSE, 8));
    }

    #[test]
    fn decoration_for_a_layer_window_is_answered_client_side() {
        let (_guard, mut conn) = fixture();
        convert(&mut conn);

        let mut body = word(60);
        body.extend_from_slice(&word(30));
        let action =
            on_get_toplevel_decoration(&mut conn, &message(9, REQ_GET_TOPLEVEL_DECORATION, &body));

        let messages = replaced(action);

        // The suppressed creation is replaced by a callback that reserves the
        // id on the compositor, so the map keeps growing densely.
        assert_eq!(messages.len(), 1);
        assert_eq!(header(&messages[0]), (1, 0, 12), "wl_display.sync");
        assert_eq!(u32_at(&messages[0], 8), 60);
        assert!(conn.injected_ids.contains(&60));
        assert_eq!(conn.ifaces.get(&60), Some(&Iface::ZxdgToplevelDecoration));
        assert_eq!(
            conn.pending_to_client.len(),
            1,
            "the client is owed an answer"
        );
        let event = &conn.pending_to_client[0];
        assert_eq!(header(event), (60, EVT_DECORATION_CONFIGURE, 12));
        assert_eq!(u32_at(event, 8), DECORATION_CLIENT_SIDE);
    }

    #[test]
    fn decoration_for_an_ordinary_toplevel_is_forwarded() {
        let (_guard, mut conn) = fixture();

        let mut body = word(60);
        body.extend_from_slice(&word(30));
        let action =
            on_get_toplevel_decoration(&mut conn, &message(9, REQ_GET_TOPLEVEL_DECORATION, &body));

        assert!(matches!(action, Action::Forward));
        assert!(conn.pending_to_client.is_empty());
    }

    #[test]
    fn popup_decoration_and_icon_requests_never_reach_the_compositor() {
        let (_guard, mut conn) = fixture();
        conn.ifaces.insert(30, Iface::XdgPopupShim);
        let mut body = word(60);
        body.extend_from_slice(&word(30));
        assert!(matches!(
            on_get_toplevel_decoration(&mut conn, &message(9, REQ_GET_TOPLEVEL_DECORATION, &body)),
            Action::Replace(_)
        ));
        assert_eq!(conn.ifaces.get(&60), Some(&Iface::ZxdgToplevelDecoration));
        assert!(matches!(
            on_decoration_object_request(&mut conn, &message(60, 1, &word(1))),
            Action::Suppress
        ));
        assert!(matches!(
            on_set_icon(&mut conn, &message(8, REQ_SET_ICON, &word(30))),
            Action::Suppress
        ));
        assert!(matches!(
            on_decoration_object_request(&mut conn, &message(60, REQ_DECORATION_DESTROY, &[])),
            Action::Suppress
        ));
        assert!(!conn.ifaces.contains_key(&60));
    }

    #[test]
    fn requests_on_the_stub_decoration_are_dropped() {
        let (_guard, mut conn) = fixture();
        conn.ifaces.insert(60, Iface::ZxdgToplevelDecoration);

        let action = on_decoration_object_request(&mut conn, &message(60, 1, &word(1)));
        assert!(matches!(action, Action::Suppress));

        let action =
            on_decoration_object_request(&mut conn, &message(60, REQ_DECORATION_DESTROY, &[]));
        assert!(matches!(action, Action::Suppress));
        assert!(!conn.ifaces.contains_key(&60));
    }

    /// `set_icon(toplevel, icon)` — the icon object is fine, the toplevel it
    /// names is not one the compositor knows about.
    #[test]
    fn set_icon_for_a_layer_window_is_dropped() {
        let (_guard, mut conn) = fixture();
        convert(&mut conn);

        let mut body = word(30);
        body.extend_from_slice(&word(70));
        let action = on_set_icon(&mut conn, &message(27, REQ_SET_ICON, &body));

        assert!(matches!(action, Action::Suppress));
    }

    #[test]
    fn set_icon_for_an_ordinary_toplevel_is_forwarded() {
        let (_guard, mut conn) = fixture();

        let mut body = word(30);
        body.extend_from_slice(&word(70));
        let action = on_set_icon(&mut conn, &message(27, REQ_SET_ICON, &body));

        assert!(matches!(action, Action::Forward));
    }
}
