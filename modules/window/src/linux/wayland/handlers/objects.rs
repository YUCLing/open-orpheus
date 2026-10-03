//! Object-graph tracking: registry binds, surface/pointer/xdg creation,
//! destruction, and `delete_id` ID stealing.

use std::os::fd::RawFd;

use super::super::codec::{Iface, REQ_SET_WINDOW_GEOMETRY, WlMessage};
use super::super::state::{
    CUSTOM_ID_MAP, PopupGeometry, WaylandConn, cancel_pending_popup_for_connection,
    cancel_pending_popup_for_parent, take_pending_popup,
};
use super::{Action, Effects};

pub(crate) fn on_get_registry(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    if let Some(new_id) = msg.u32_arg(8) {
        conn.ifaces.insert(new_id, Iface::WlRegistry);
        conn.registry_id = Some(new_id);
    }
    Action::Forward
}

pub(crate) fn on_bind(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    if let Some((iface_name, after)) = msg.str_arg(12)
        && let Some(new_id) = msg.u32_arg(after + 4)
    {
        let tag = match iface_name {
            "wl_compositor" => {
                conn.compositor_id = Some(new_id);
                Some(Iface::WlCompositor)
            }
            "wl_seat" => Some(Iface::WlSeat),
            "zxdg_decoration_manager_v1" => Some(Iface::ZxdgDecorationManager),
            "xdg_toplevel_icon_manager_v1" => Some(Iface::XdgToplevelIconManager),
            "xdg_wm_base" => {
                conn.xdg_wm_base_id = Some(new_id);
                Some(Iface::XdgWmBase)
            }
            _ => None,
        };
        if let Some(tag) = tag {
            conn.ifaces.insert(new_id, tag);
        }
    }
    Action::Forward
}

pub(crate) fn on_create_surface(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    if let Some(new_id) = msg.u32_arg(8) {
        conn.ifaces.insert(new_id, Iface::WlSurface);
    }
    Action::Forward
}

pub(crate) fn on_get_pointer(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    if let Some(new_id) = msg.u32_arg(8) {
        conn.ifaces.insert(new_id, Iface::WlPointer);
        conn.pointer_seat.insert(new_id, msg.object_id);
    }
    Action::Forward
}

pub(crate) fn on_get_touch(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    if let Some(new_id) = msg.u32_arg(8) {
        conn.ifaces.insert(new_id, Iface::WlTouch);
        conn.touch_seat.insert(new_id, msg.object_id);
    }
    Action::Forward
}

pub(crate) fn on_get_xdg_surface(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    if let (Some(xdg_id), Some(wl_id)) = (msg.u32_arg(8), msg.u32_arg(12)) {
        conn.ifaces.insert(xdg_id, Iface::XdgSurface);
        conn.xdg_to_wl.insert(xdg_id, wl_id);
    }
    Action::Forward
}

fn push_message(out: &mut Vec<u8>, object_id: u32, opcode: u16, args: &[i32]) {
    let size = 8 + args.len() * 4;
    out.extend_from_slice(&object_id.to_ne_bytes());
    out.extend_from_slice(&((opcode as u32) | ((size as u32) << 16)).to_ne_bytes());
    for arg in args {
        out.extend_from_slice(&arg.to_ne_bytes());
    }
}

pub(crate) fn on_get_toplevel(
    fd: RawFd,
    conn: &mut WaylandConn,
    msg: &WlMessage,
    fx: &mut Effects,
) -> Action {
    if let Some(top_id) = msg.u32_arg(8) {
        if let Some(wm_base_id) = conn.xdg_wm_base_id
            && let Some(popup) =
                take_pending_popup(fd, conn.role_window_id.as_deref().unwrap_or(""))
        {
            let positioner_id = popup.positioner_id;
            let geometry = PopupGeometry {
                inset: popup.shadow_inset,
                width: popup.width - popup.shadow_inset * 2,
                height: popup.height - popup.shadow_inset * 2,
            };
            let mut replacement = Vec::with_capacity(128);
            // xdg_wm_base.create_positioner(new_id)
            push_message(
                &mut replacement,
                wm_base_id,
                super::super::codec::REQ_CREATE_POSITIONER,
                &[positioner_id as i32],
            );
            // xdg_positioner: size, anchor rect, anchor, gravity, constraints.
            push_message(
                &mut replacement,
                positioner_id,
                1,
                &[geometry.width, geometry.height],
            );
            push_message(
                &mut replacement,
                positioner_id,
                super::super::codec::REQ_GET_POPUP,
                &[popup.anchor_x, popup.anchor_y, 1, 1],
            );
            push_message(&mut replacement, positioner_id, 3, &[5]); // top_left
            push_message(&mut replacement, positioner_id, 4, &[8]); // bottom_right
            push_message(&mut replacement, positioner_id, 5, &[15]); // slide + flip
            // xdg_surface.get_popup(new_id, parent, positioner)
            push_message(
                &mut replacement,
                msg.object_id,
                2,
                &[
                    top_id as i32,
                    popup.parent_xdg_surface_id as i32,
                    positioner_id as i32,
                ],
            );
            push_message(&mut replacement, positioner_id, 0, &[]);
            // Position the menu itself, not the transparent shadow buffer.
            if geometry.inset > 0 {
                push_message(
                    &mut replacement,
                    msg.object_id,
                    REQ_SET_WINDOW_GEOMETRY,
                    &[
                        geometry.inset,
                        geometry.inset,
                        geometry.width,
                        geometry.height,
                    ],
                );
                conn.popup_geometries.insert(msg.object_id, geometry);
            }

            conn.ifaces.insert(positioner_id, Iface::XdgPositioner);
            conn.ifaces.insert(top_id, Iface::XdgPopupShim);
            conn.top_to_xdg.insert(top_id, msg.object_id);
            if let Some(wl_id) = conn.xdg_to_wl.get(&msg.object_id).copied() {
                conn.wl_to_top.insert(wl_id, top_id);
                fx.arm_watchers_for.push(wl_id);
            }
            return Action::Replace(vec![replacement]);
        }
        conn.ifaces.insert(top_id, Iface::XdgToplevel);
        conn.top_to_xdg.insert(top_id, msg.object_id);
        if let Some(wl_id) = conn.xdg_to_wl.get(&msg.object_id).copied() {
            conn.wl_to_top.insert(wl_id, top_id);
            // The surface is a toplevel for good: a compositor never releases
            // the role, so it can never become a layer surface.
            conn.toplevel_surfaces.insert(wl_id);
            fx.arm_watchers_for.push(wl_id);
        }
    }
    Action::Forward
}

pub(crate) fn on_popup_geometry(conn: &WaylandConn, msg: &WlMessage) -> Action {
    let Some(geometry) = conn.popup_geometries.get(&msg.object_id) else {
        return Action::Forward;
    };
    let mut replacement = Vec::new();
    push_message(
        &mut replacement,
        msg.object_id,
        REQ_SET_WINDOW_GEOMETRY,
        &[
            geometry.inset,
            geometry.inset,
            geometry.width,
            geometry.height,
        ],
    );
    Action::Replace(vec![replacement])
}

pub(crate) fn on_popup_event(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    match msg.opcode {
        // Translate xdg_popup.configure(x, y, width, height) into the
        // xdg_toplevel.configure(width, height, states[]) Chromium expects.
        0 => {
            let (Some(width), Some(height)) = (msg.u32_arg(16), msg.u32_arg(20)) else {
                return Action::Suppress;
            };
            let inset = conn
                .top_to_xdg
                .get(&msg.object_id)
                .and_then(|xdg| conn.popup_geometries.get_mut(xdg))
                .map(|geometry| {
                    geometry.width = width as i32;
                    geometry.height = height as i32;
                    geometry.inset
                })
                .unwrap_or(0);
            let mut replacement = Vec::with_capacity(20);
            push_message(
                &mut replacement,
                msg.object_id,
                0,
                &[width as i32 + inset * 2, height as i32 + inset * 2, 0],
            );
            Action::Replace(vec![replacement])
        }
        1 => Action::Forward,
        _ => Action::Suppress,
    }
}

pub(crate) fn on_destroy(
    fd: RawFd,
    conn: &mut WaylandConn,
    msg: &WlMessage,
    fx: &mut Effects,
) -> Action {
    if let Some(iface) = conn.ifaces.get(&msg.object_id).copied() {
        if iface == Iface::XdgWmBase {
            cancel_pending_popup_for_connection(fd, conn);
        }
        let wl_surface_id = conn.wl_surface_for_window_object(msg.object_id, iface);
        let parent_xdg_surface_ids: Vec<u32> = match iface {
            Iface::WlSurface => conn
                .xdg_to_wl
                .iter()
                .filter_map(|(xdg, wl)| (*wl == msg.object_id).then_some(*xdg))
                .collect(),
            Iface::XdgSurface => vec![msg.object_id],
            Iface::XdgToplevel | Iface::XdgPopupShim => conn
                .top_to_xdg
                .get(&msg.object_id)
                .copied()
                .into_iter()
                .collect(),
            _ => Vec::new(),
        };
        for parent_xdg_surface_id in parent_xdg_surface_ids {
            cancel_pending_popup_for_parent(fd, parent_xdg_surface_id, conn);
        }
        if let Some(wl_surface_id) = wl_surface_id {
            fx.destroyed_surfaces.push(wl_surface_id);
            if let Some(m) = CUSTOM_ID_MAP.get()
                && let Ok(mut map) = m.lock()
            {
                map.retain(|_, value| !(value.0 == fd && value.1 == wl_surface_id));
            }
        }
    }
    conn.purge(msg.object_id);
    Action::Forward
}

pub(crate) fn on_pointer_release(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    conn.purge(msg.object_id);
    Action::Forward
}

pub(crate) fn on_touch_release(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    conn.purge(msg.object_id);
    Action::Forward
}

pub(crate) fn on_delete_id(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    if let Some(dead) = msg.u32_arg(8) {
        // If it's one of our injected IDs, we're done with it — recycle it.
        if conn.injected_ids.remove(&dead) {
            // Unless the client still owns a shadow object under this id (a
            // decoration whose compositor-side resource was a throwaway): its
            // requests must keep being intercepted, and the id must not be
            // handed out again while it lives.
            if conn.ifaces.get(&dead) == Some(&Iface::ZxdgToplevelDecoration) {
                return Action::Suppress;
            }
            conn.purge(dead);
            conn.stolen_ids.push(dead);
            return Action::Suppress;
        }

        conn.purge(dead);

        // Otherwise steal up to 32 deleted IDs from the client for our own use.
        // Reserve a small pool of compositor-confirmed client IDs for injected
        // region/positioner objects. Arbitrary fresh IDs are not accepted by
        // every Wayland compositor.
        if conn.stolen_ids.len() < 32 {
            conn.stolen_ids.push(dead);
            return Action::Suppress;
        }
    }
    Action::Forward
}

#[cfg(test)]
mod popup_shadow_tests {
    use super::super::super::test_support::{message, request};
    use super::*;

    #[test]
    fn positioner_uses_content_size_and_preserves_the_anchor() {
        use super::super::super::{
            codec::{REQ_GET_TOPLEVEL, decode},
            state::{self, PENDING_POPUPS, PendingPopup},
        };
        state::init_state();
        let fd = 94_101;
        PENDING_POPUPS.get().unwrap().lock().unwrap().insert(
            fd,
            PendingPopup {
                token: 101,
                parent_xdg_surface_id: 20,
                width: 280,
                height: 329,
                shadow_inset: 24,
                anchor_x: 70,
                anchor_y: 80,
                positioner_id: 900,
                target_window_id: "shadow-menu".into(),
            },
        );
        let mut conn = WaylandConn::new();
        conn.xdg_wm_base_id = Some(2);
        conn.role_window_id = Some("shadow-menu".into());
        let msg = WlMessage::new(
            40,
            REQ_GET_TOPLEVEL,
            request(40, REQ_GET_TOPLEVEL, 12, &[50]),
        );
        let Action::Replace(out) = on_get_toplevel(fd, &mut conn, &msg, &mut Effects::default())
        else {
            panic!("popup not converted")
        };
        let (messages, _) = decode(&out.concat());
        let size = messages
            .iter()
            .find(|m| m.object_id == 900 && m.opcode == 1)
            .unwrap();
        assert_eq!(size.raw(), request(900, 1, 16, &[232, 281]));
        let anchor = messages
            .iter()
            .find(|m| m.object_id == 900 && m.opcode == 2)
            .unwrap();
        assert_eq!(anchor.raw(), request(900, 2, 24, &[70, 80, 1, 1]));
        let geometry = messages
            .iter()
            .find(|m| m.object_id == 40 && m.opcode == REQ_SET_WINDOW_GEOMETRY)
            .unwrap();
        assert_eq!(
            geometry.raw(),
            request(40, REQ_SET_WINDOW_GEOMETRY, 24, &[24, 24, 232, 281])
        );
        state::clear_runtime_state_for_fd(fd);
    }

    fn padded_connection() -> WaylandConn {
        let mut conn = WaylandConn::new();
        conn.ifaces.insert(40, Iface::XdgSurface);
        conn.ifaces.insert(50, Iface::XdgPopupShim);
        conn.ifaces.insert(10, Iface::WlSurface);
        conn.xdg_to_wl.insert(40, 10);
        conn.top_to_xdg.insert(50, 40);
        conn.popup_geometries.insert(
            40,
            PopupGeometry {
                inset: 24,
                width: 232,
                height: 281,
            },
        );
        conn
    }

    #[test]
    fn geometry_excludes_shadow_and_configure_restores_buffer_size() {
        let mut conn = padded_connection();
        let raw = request(40, 3, 24, &[0, 0, 280, 329]);
        let msg = WlMessage::new(40, 3, raw);
        let Action::Replace(out) = on_popup_geometry(&conn, &msg) else {
            panic!("geometry not rewritten")
        };
        assert_eq!(out, vec![request(40, 3, 24, &[24, 24, 232, 281])]);
        let configure = WlMessage::new(50, 0, request(50, 0, 24, &[10, 20, 232, 281]));
        let Action::Replace(out) = on_popup_event(&mut conn, &configure) else {
            panic!("configure not translated")
        };
        assert_eq!(out, vec![request(50, 0, 20, &[280, 329, 0])]);
        // Non-popup windows must retain their original geometry.
        assert!(matches!(
            on_popup_geometry(&conn, &message(41, 3, &[])),
            Action::Forward
        ));
    }

    #[test]
    fn shadow_state_dies_with_role_surface_and_connection() {
        for id in [10, 40, 50] {
            let mut conn = padded_connection();
            conn.purge(id);
            assert!(conn.popup_geometries.is_empty(), "object {id}");
        }
        let mut conn = padded_connection();
        conn.reset_tracking();
        assert!(conn.popup_geometries.is_empty());
    }
}
