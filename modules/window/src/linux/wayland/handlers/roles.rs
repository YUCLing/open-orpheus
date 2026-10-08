//! A role must be assigned before its title can be sent. Hold only the role
//! and its related initialization requests until that title identifies the
//! managed window. An unrelated request (including commit/sync/destruction)
//! flushes it as an ordinary role: never guess which window owns a reservation.
use std::os::fd::RawFd;

use super::super::{
    codec::{
        Iface, REQ_DESTROY, REQ_GET_TOPLEVEL, REQ_GET_TOPLEVEL_DECORATION, REQ_SET_ICON,
        REQ_SET_TITLE, WlMessage, parse_custom_title,
    },
    state::{WaylandConn, has_named_role_pending},
};
use super::{Action, Effects, dispatch_request_inner};

const MAX_DEFERRED_ROLE_REQUESTS: usize = 32;

pub(crate) struct DeferredRole {
    top_id: u32,
    messages: Vec<WlMessage>,
    /// Decoration objects introduced by this role's queued constructors.
    decoration_ids: Vec<u32>,
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
        let decoration_id = (conn.ifaces.get(&msg.object_id)
            == Some(&Iface::ZxdgDecorationManager)
            && msg.opcode == REQ_GET_TOPLEVEL_DECORATION
            && msg.u32_arg(12) == Some(held.top_id))
        .then(|| msg.u32_arg(8))
        .flatten();
        let is_icon = conn.ifaces.get(&msg.object_id) == Some(&Iface::XdgToplevelIconManager)
            && msg.opcode == REQ_SET_ICON
            && msg.u32_arg(8) == Some(held.top_id);
        let belongs_to_role = msg.object_id == held.top_id
            || decoration_id.is_some()
            || held.decoration_ids.contains(&msg.object_id)
            || is_icon;
        // Preserve wire order only for this role's initialization. Unrelated
        // requests, sync/commit and destruction still flush without guessing.
        if managed_id.is_none()
            && belongs_to_role
            && msg.opcode != REQ_DESTROY
            && held.messages.len() < MAX_DEFERRED_ROLE_REQUESTS
            && has_named_role_pending(fd)
        {
            if let Some(id) = decoration_id {
                held.decoration_ids.push(id);
            }
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
            decoration_ids: Vec::new(),
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
        let _state_guard = crate::linux::wayland::test_support::lock_state();
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
        let _state_guard = crate::linux::wayland::test_support::lock_state();
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
        let _state_guard = crate::linux::wayland::test_support::lock_state();
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

    #[test]
    fn related_decoration_and_icon_initialization_wait_for_window_identity() {
        let _state_guard = crate::linux::wayland::test_support::lock_state();
        for (fd, owner, converted) in [(94_004, "menu-target", true), (94_005, "foreign", false)] {
            let mut conn = reserved(fd);
            conn.ifaces.insert(7, Iface::ZxdgDecorationManager);
            conn.ifaces.insert(8, Iface::XdgToplevelIconManager);
            let role = message(40, REQ_GET_TOPLEVEL, &word(50));
            let decoration = message(
                7,
                REQ_GET_TOPLEVEL_DECORATION,
                &[word(60), word(50)].concat(),
            );
            let mode = message(60, 1, &word(2));
            let icon = message(8, REQ_SET_ICON, &[word(50), word(70)].concat());
            for request in [&role, &decoration, &mode, &icon] {
                assert!(send(fd, &mut conn, request).is_empty());
            }
            // An initial unadorned title must not assign the role prematurely.
            assert!(send(fd, &mut conn, &message(50, REQ_SET_TITLE, &wl_string(""))).is_empty());
            let out = send(
                fd,
                &mut conn,
                &message(
                    50,
                    REQ_SET_TITLE,
                    &wl_string(&decorate_title(owner, "Menu")),
                ),
            );
            if converted {
                assert_eq!(conn.ifaces.get(&50), Some(&Iface::XdgPopupShim));
                assert_eq!(conn.ifaces.get(&60), Some(&Iface::ZxdgToplevelDecoration));
                assert_eq!(conn.pending_to_client.len(), 1);
                // No request typed as xdg_toplevel may reach the compositor
                // after the role became a popup. Reuse the existing shim.
                assert!(
                    !out.iter().any(|raw| raw == decoration.raw()
                        || raw == mode.raw()
                        || raw == icon.raw())
                );
                assert!(send(fd, &mut conn, &message(60, REQ_DESTROY, &[])).is_empty());
                assert!(!conn.ifaces.contains_key(&60));
                assert!(!conn.injected_ids.contains(&60));
            } else {
                assert_eq!(conn.ifaces.get(&50), Some(&Iface::XdgToplevel));
                assert_eq!(out.len(), 6);
                for (actual, request) in out.iter().zip([&role, &decoration, &mode, &icon]) {
                    assert_eq!(actual, request.raw());
                }
                assert!(conn.pending_to_client.is_empty());
                assert!(
                    PENDING_POPUPS
                        .get()
                        .unwrap()
                        .lock()
                        .unwrap()
                        .contains_key(&fd)
                );
            }
            assert!(conn.deferred_role.is_none());
            state::clear_runtime_state_for_fd(fd);
        }
    }

    #[test]
    fn another_windows_decoration_flushes_without_consuming_the_popup() {
        let _state_guard = crate::linux::wayland::test_support::lock_state();
        let fd = 94_006;
        let mut conn = reserved(fd);
        conn.ifaces.insert(7, Iface::ZxdgDecorationManager);
        let role = message(40, REQ_GET_TOPLEVEL, &word(50));
        assert!(send(fd, &mut conn, &role).is_empty());
        let foreign = message(
            7,
            REQ_GET_TOPLEVEL_DECORATION,
            &[word(60), word(51)].concat(),
        );
        let out = send(fd, &mut conn, &foreign);
        assert_eq!(out, vec![role.raw().to_vec(), foreign.raw().to_vec()]);
        assert_eq!(conn.ifaces.get(&50), Some(&Iface::XdgToplevel));
        assert!(conn.deferred_role.is_none());
        assert!(
            PENDING_POPUPS
                .get()
                .unwrap()
                .lock()
                .unwrap()
                .contains_key(&fd)
        );
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn decoration_destruction_flushes_queued_initialization_in_order() {
        let _state_guard = crate::linux::wayland::test_support::lock_state();
        let fd = 94_007;
        let mut conn = reserved(fd);
        conn.ifaces.insert(7, Iface::ZxdgDecorationManager);
        let role = message(40, REQ_GET_TOPLEVEL, &word(50));
        let decoration = message(
            7,
            REQ_GET_TOPLEVEL_DECORATION,
            &[word(60), word(50)].concat(),
        );
        assert!(send(fd, &mut conn, &role).is_empty());
        assert!(send(fd, &mut conn, &decoration).is_empty());
        let destroy = message(60, REQ_DESTROY, &[]);
        let out = send(fd, &mut conn, &destroy);
        assert_eq!(
            out,
            vec![
                role.raw().to_vec(),
                decoration.raw().to_vec(),
                destroy.raw().to_vec()
            ]
        );
        assert_eq!(conn.ifaces.get(&50), Some(&Iface::XdgToplevel));
        assert!(conn.deferred_role.is_none());
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn cancellation_with_queued_decoration_preserves_an_ordinary_window() {
        let _state_guard = crate::linux::wayland::test_support::lock_state();
        let fd = 94_008;
        let mut conn = reserved(fd);
        conn.ifaces.insert(7, Iface::ZxdgDecorationManager);
        let role = message(40, REQ_GET_TOPLEVEL, &word(50));
        let decoration = message(
            7,
            REQ_GET_TOPLEVEL_DECORATION,
            &[word(60), word(50)].concat(),
        );
        assert!(send(fd, &mut conn, &role).is_empty());
        assert!(send(fd, &mut conn, &decoration).is_empty());
        state::clear_runtime_state_for_fd(fd);
        let title = message(
            50,
            REQ_SET_TITLE,
            &wl_string(&decorate_title("menu-target", "Menu")),
        );
        let out = send(fd, &mut conn, &title);
        assert_eq!(out[0], role.raw());
        assert_eq!(out[1], decoration.raw());
        assert_eq!(conn.ifaces.get(&50), Some(&Iface::XdgToplevel));
        assert!(conn.deferred_role.is_none());
        assert!(conn.pending_to_client.is_empty());
        state::clear_runtime_state_for_fd(fd);
    }
}
