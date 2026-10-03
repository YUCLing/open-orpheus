//! A role must be assigned before its title can be sent. Hold only the role
//! and its toplevel initialization requests until that title identifies the
//! managed window. An unrelated request (including commit/sync/destruction)
//! flushes it as an ordinary role: never guess which window owns a reservation.
use std::os::fd::RawFd;

use super::super::{
    codec::{Iface, REQ_GET_TOPLEVEL, REQ_SET_TITLE, WlMessage, parse_custom_title},
    state::{WaylandConn, has_named_role_pending},
};
use super::{Action, Effects, dispatch_request_inner};

pub(crate) struct DeferredRole {
    top_id: u32,
    messages: Vec<WlMessage>,
}

fn append(out: &mut Vec<Vec<u8>>, msg: &WlMessage, action: Action) {
    match action {
        Action::Forward => out.push(msg.raw().to_vec()),
        Action::Suppress => {}
        Action::Replace(messages) => out.extend(messages),
    }
}

pub(crate) fn dispatch(
    fd: RawFd,
    conn: &mut WaylandConn,
    msg: &WlMessage,
    fx: &mut Effects,
) -> Action {
    let defer_current = conn.ifaces.get(&msg.object_id) == Some(&Iface::XdgSurface)
        && msg.opcode == REQ_GET_TOPLEVEL
        && msg.u32_arg(8).is_some()
        && has_named_role_pending(fd);
    if conn.deferred_role.is_none() && !defer_current {
        return dispatch_request_inner(fd, conn, msg, fx);
    }
    let mut out = Vec::new();
    if let Some(mut held) = conn.deferred_role.take() {
        let is_title = msg.object_id == held.top_id && msg.opcode == REQ_SET_TITLE;
        let managed_id = if is_title {
            msg.str_text(8)
                .and_then(parse_custom_title)
                .map(|(id, _)| id.to_owned())
        } else {
            None
        };
        // Bound memory and do not hold destroy or requests on other objects.
        if managed_id.is_none()
            && msg.object_id == held.top_id
            && msg.opcode != 0
            && held.messages.len() < 32
            && has_named_role_pending(fd)
        {
            held.messages.push(WlMessage::new(
                msg.object_id,
                msg.opcode,
                msg.raw().to_vec(),
            ));
            conn.deferred_role = Some(held);
            return Action::Suppress;
        }
        conn.role_window_id = managed_id;
        for queued in held.messages {
            let action = dispatch_request_inner(fd, conn, &queued, fx);
            append(&mut out, &queued, action);
        }
        conn.role_window_id = None;
    }
    if defer_current && let Some(top_id) = msg.u32_arg(8) {
        conn.deferred_role = Some(DeferredRole {
            top_id,
            messages: vec![WlMessage::new(
                msg.object_id,
                msg.opcode,
                msg.raw().to_vec(),
            )],
        });
    } else {
        let action = dispatch_request_inner(fd, conn, msg, fx);
        append(&mut out, msg, action);
    }
    Action::Replace(out)
}

#[cfg(test)]
mod tests {
    use super::super::super::{
        codec::decorate_title,
        state::{self, PENDING_POPUPS, PendingPopup},
        test_support::{message, wl_string, word},
    };
    use super::*;

    fn reserved(fd: RawFd) -> WaylandConn {
        state::init_state();
        PENDING_POPUPS.get().unwrap().lock().unwrap().insert(
            fd,
            PendingPopup {
                token: fd as u32,
                parent_xdg_surface_id: 20,
                width: 100,
                height: 80,
                shadow_inset: 0,
                anchor_x: 4,
                anchor_y: 5,
                positioner_id: 900,
                target_window_id: "menu-target".into(),
            },
        );
        let mut conn = WaylandConn::new();
        conn.xdg_wm_base_id = Some(2);
        conn.ifaces.insert(40, Iface::XdgSurface);
        conn.ifaces.insert(41, Iface::XdgSurface);
        conn.ifaces.insert(10, Iface::WlSurface);
        conn.xdg_to_wl.insert(40, 10);
        conn.xdg_to_wl.insert(41, 11);
        conn
    }

    fn send(fd: RawFd, conn: &mut WaylandConn, msg: &WlMessage) -> Vec<Vec<u8>> {
        let mut fx = Effects::default();
        let mut out = Vec::new();
        append(&mut out, msg, dispatch(fd, conn, msg, &mut fx));
        out
    }

    #[test]
    fn foreign_window_cannot_consume_popup_and_initial_requests_keep_order() {
        let fd = 94_001;
        let mut conn = reserved(fd);
        assert!(send(fd, &mut conn, &message(40, REQ_GET_TOPLEVEL, &word(50))).is_empty());
        assert!(send(fd, &mut conn, &message(50, 3, &wl_string("orpheus"))).is_empty());
        let foreign = message(
            50,
            REQ_SET_TITLE,
            &wl_string(&decorate_title("foreign", "Other")),
        );
        let out = send(fd, &mut conn, &foreign);
        assert_eq!(out[0], message(40, REQ_GET_TOPLEVEL, &word(50)).raw());
        assert_eq!(out[1], message(50, 3, &wl_string("orpheus")).raw());
        assert_eq!(conn.ifaces.get(&50), Some(&Iface::XdgToplevel));
        assert!(
            PENDING_POPUPS
                .get()
                .unwrap()
                .lock()
                .unwrap()
                .contains_key(&fd)
        );
        assert!(send(fd, &mut conn, &message(41, REQ_GET_TOPLEVEL, &word(51))).is_empty());
        // Chromium may send a bare initial title before the decorated title.
        assert!(send(fd, &mut conn, &message(51, REQ_SET_TITLE, &wl_string(""))).is_empty());
        send(
            fd,
            &mut conn,
            &message(
                51,
                REQ_SET_TITLE,
                &wl_string(&decorate_title("menu-target", "Menu")),
            ),
        );
        assert_eq!(conn.ifaces.get(&51), Some(&Iface::XdgPopupShim));
        assert!(
            !PENDING_POPUPS
                .get()
                .unwrap()
                .lock()
                .unwrap()
                .contains_key(&fd)
        );
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn commit_without_identity_flushes_an_ordinary_role_instead_of_guessing() {
        let fd = 94_002;
        let mut conn = reserved(fd);
        send(fd, &mut conn, &message(40, REQ_GET_TOPLEVEL, &word(50)));
        let commit = message(10, 6, &[]);
        let out = send(fd, &mut conn, &commit);
        assert_eq!(out[0], message(40, REQ_GET_TOPLEVEL, &word(50)).raw());
        assert_eq!(out[1], commit.raw());
        assert!(conn.deferred_role.is_none());
        assert_eq!(conn.ifaces.get(&50), Some(&Iface::XdgToplevel));
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn cancellation_before_title_does_not_convert_a_destroyed_menu() {
        let fd = 94_003;
        let mut conn = reserved(fd);
        send(fd, &mut conn, &message(40, REQ_GET_TOPLEVEL, &word(50)));
        state::clear_runtime_state_for_fd(fd);
        send(
            fd,
            &mut conn,
            &message(
                50,
                REQ_SET_TITLE,
                &wl_string(&decorate_title("menu-target", "Menu")),
            ),
        );
        assert_eq!(conn.ifaces.get(&50), Some(&Iface::XdgToplevel));
        assert!(conn.deferred_role.is_none());
    }
}
