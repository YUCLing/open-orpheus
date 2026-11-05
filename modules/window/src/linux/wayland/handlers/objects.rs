//! Object-graph tracking: registry binds, surface/pointer/xdg creation,
//! destruction, and `delete_id` ID stealing.

use std::os::fd::RawFd;

use super::super::codec::{
    EVT_OUTPUT_NAME, EVT_POPUP_CONFIGURE, EVT_POPUP_DONE, EVT_TOPLEVEL_CONFIGURE, Iface,
    REQ_CREATE_POSITIONER, REQ_DESTROY, REQ_GET_POPUP, REQ_POSITIONER_SET_ANCHOR,
    REQ_POSITIONER_SET_ANCHOR_RECT, REQ_POSITIONER_SET_CONSTRAINT_ADJUSTMENT,
    REQ_POSITIONER_SET_GRAVITY, REQ_POSITIONER_SET_SIZE, REQ_SET_WINDOW_GEOMETRY, WlMessage,
};
use super::super::layer_shell::xdg_toplevel_configure;
use super::super::outputs;
use super::super::state::{
    LAST_BUTTON, PopupGeometry, PopupPolicy, SurfaceRole, WaylandConn, popup_policy,
    take_popup_policy,
};
use super::{Action, Effects};

// xdg_positioner enums, distinct from layer-shell's anchor bitmask.
const POSITIONER_TOP_LEFT: i32 = 5;
const POSITIONER_TOP_RIGHT: i32 = 7;
const POSITIONER_BOTTOM_RIGHT: i32 = 8;
const POSITIONER_SLIDE_X: i32 = 1;
const POSITIONER_SLIDE_Y: i32 = 2;
const POSITIONER_FLIP_X: i32 = 4;
const POSITIONER_FLIP_Y: i32 = 8;

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
        let global_name = msg.u32_arg(8);
        let tag = match iface_name {
            "wl_compositor" => {
                conn.compositor_id = Some(new_id);
                Some(Iface::WlCompositor)
            }
            "wl_seat" => Some(Iface::WlSeat),
            // The object is what a layer surface is created on; the global
            // name is the `Display.id` the application named it by.
            "wl_output" => {
                if let Some(global_name) = global_name {
                    outputs::bound(conn, global_name, new_id);
                }
                Some(Iface::WlOutput)
            }
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
    window_id: Option<&str>,
) -> Action {
    if let Some(top_id) = msg.u32_arg(8) {
        // A window the application registered as a popup becomes one here, once
        // the decorated title has named it. Everything the positioner needs is
        // resolved at this point, so registering the intent could not fail for
        // want of a parent surface or an object id.
        if let Some(id) = window_id
            && let Some(policy) = popup_policy(id)
            && let Some(replacement) = build_popup_role(fd, conn, msg.object_id, top_id, &policy)
        {
            take_popup_policy(id);
            return Action::Replace(vec![replacement]);
        }

        conn.ifaces.insert(top_id, Iface::XdgToplevel);
        conn.top_to_xdg.insert(top_id, msg.object_id);
        if let Some(wl_id) = conn.xdg_to_wl.get(&msg.object_id).copied() {
            conn.wl_to_top.insert(wl_id, top_id);
            // The surface is a toplevel for good: a compositor never releases
            // the role, so it can never become a layer surface. Keep any
            // refusal already reported for it.
            conn.surface_roles
                .entry(wl_id)
                .or_insert(SurfaceRole::Toplevel { reported: false });
        }
    }
    Action::Forward
}

/// Replace `xdg_surface.get_toplevel` with the `xdg_popup` role the client's
/// window was registered for, or `None` to leave it an ordinary toplevel.
fn build_popup_role(
    fd: RawFd,
    conn: &mut WaylandConn,
    xdg_surface_id: u32,
    top_id: u32,
    policy: &PopupPolicy,
) -> Option<Vec<u8>> {
    let wm_base_id = conn.xdg_wm_base_id?;
    // The parent has to be on this connection, and a layer surface cannot be an
    // xdg_popup's xdg parent.
    let parent_wl_surface = conn
        .surface_ids
        .iter()
        .find_map(|(surface, id)| (id == &policy.parent_window_id).then_some(*surface))?;
    if matches!(
        conn.surface_roles.get(&parent_wl_surface),
        Some(SurfaceRole::Layer(_))
    ) {
        return None;
    }
    let parent_xdg_surface_id = conn
        .xdg_to_wl
        .iter()
        .find_map(|(xdg, wl)| (*wl == parent_wl_surface).then_some(*xdg))?;
    let (anchor_x, anchor_y) = match policy.anchor {
        Some(anchor) => anchor,
        None => {
            let button = LAST_BUTTON
                .get()
                .and_then(|v| v.lock().ok())
                .and_then(|v| v.by_surface.get(&(fd, parent_wl_surface)).copied())?;
            (button.x, button.y)
        }
    };
    let positioner_id = conn.alloc_injected_id()?;

    let geometry = PopupGeometry {
        inset: policy.shadow_inset,
        width: policy.width - policy.shadow_inset * 2,
        height: policy.height - policy.shadow_inset * 2,
    };
    let mut replacement = Vec::with_capacity(128);
    // xdg_wm_base.create_positioner(new_id)
    push_message(
        &mut replacement,
        wm_base_id,
        REQ_CREATE_POSITIONER,
        &[positioner_id as i32],
    );
    // xdg_positioner: size, anchor rect, anchor, gravity, constraints.
    push_message(
        &mut replacement,
        positioner_id,
        REQ_POSITIONER_SET_SIZE,
        &[geometry.width, geometry.height],
    );
    let (anchor_rect, anchor) = match policy.anchor_rect_width {
        // Span from the parent's left edge to the item's right edge. Normal
        // placement starts at the item; FLIP_X moves the anchor and gravity to
        // the parent's left edge, putting the child entirely left of it.
        Some(anchor_width) => ([0, anchor_y, anchor_width, 1], POSITIONER_TOP_RIGHT),
        None => ([anchor_x, anchor_y, 1, 1], POSITIONER_TOP_LEFT),
    };
    push_message(
        &mut replacement,
        positioner_id,
        REQ_POSITIONER_SET_ANCHOR_RECT,
        &anchor_rect,
    );
    push_message(
        &mut replacement,
        positioner_id,
        REQ_POSITIONER_SET_ANCHOR,
        &[anchor],
    );
    push_message(
        &mut replacement,
        positioner_id,
        REQ_POSITIONER_SET_GRAVITY,
        &[POSITIONER_BOTTOM_RIGHT],
    );
    push_message(
        &mut replacement,
        positioner_id,
        REQ_POSITIONER_SET_CONSTRAINT_ADJUSTMENT,
        &[POSITIONER_SLIDE_X | POSITIONER_SLIDE_Y | POSITIONER_FLIP_X | POSITIONER_FLIP_Y],
    );
    // xdg_surface.get_popup(new_id, parent, positioner)
    push_message(
        &mut replacement,
        xdg_surface_id,
        REQ_GET_POPUP,
        &[
            top_id as i32,
            parent_xdg_surface_id as i32,
            positioner_id as i32,
        ],
    );
    push_message(&mut replacement, positioner_id, REQ_DESTROY, &[]);
    // Position the menu itself, not the transparent shadow buffer.
    if geometry.inset > 0 {
        push_message(
            &mut replacement,
            xdg_surface_id,
            REQ_SET_WINDOW_GEOMETRY,
            &[
                geometry.inset,
                geometry.inset,
                geometry.width,
                geometry.height,
            ],
        );
        conn.popup_geometries.insert(xdg_surface_id, geometry);
    }

    conn.ifaces.insert(positioner_id, Iface::XdgPositioner);
    conn.ifaces.insert(top_id, Iface::XdgPopupShim);
    conn.top_to_xdg.insert(top_id, xdg_surface_id);
    if let Some(wl_id) = conn.xdg_to_wl.get(&xdg_surface_id).copied() {
        conn.wl_to_top.insert(wl_id, top_id);
    }
    Some(replacement)
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

/// Track the `activated` state from `xdg_toplevel.configure`.
pub(crate) fn on_toplevel_configure(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    if msg.opcode != EVT_TOPLEVEL_CONFIGURE {
        return Action::Forward;
    }
    let Some(wl_surface) = conn
        .top_to_xdg
        .get(&msg.object_id)
        .and_then(|xdg| conn.xdg_to_wl.get(xdg))
        .copied()
    else {
        return Action::Forward;
    };
    let activated = msg
        .u32_array_arg(16)
        .is_some_and(|states| states.contains(&4));
    if activated {
        conn.activated_surfaces.insert(wl_surface);
    } else {
        conn.activated_surfaces.remove(&wl_surface);
    }
    Action::Forward
}

pub(crate) fn on_popup_event(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    match msg.opcode {
        // Translate xdg_popup.configure(x, y, width, height) into the
        // xdg_toplevel.configure(width, height, states[]) Chromium expects.
        EVT_POPUP_CONFIGURE => {
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
            Action::Replace(vec![xdg_toplevel_configure(
                msg.object_id,
                width as i32 + inset * 2,
                height as i32 + inset * 2,
            )])
        }
        EVT_POPUP_DONE => Action::Forward,
        _ => Action::Suppress,
    }
}

pub(crate) fn on_output_event(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    // `wl_output.name` is the compositor's own name for the display, e.g.
    // `DP-1`. It arrives on the object the client bound, so it is filed against
    // that object's output rather than the registry entry.
    if msg.opcode == EVT_OUTPUT_NAME
        && let Some(name) = msg.str_text(8)
    {
        outputs::named(conn, msg.object_id, name);
    }
    Action::Forward
}

pub(crate) fn on_destroy(
    _fd: RawFd,
    conn: &mut WaylandConn,
    msg: &WlMessage,
    fx: &mut Effects,
) -> Action {
    if let Some(iface) = conn.ifaces.get(&msg.object_id).copied() {
        let wl_surface_id = conn.wl_surface_for_window_object(msg.object_id, iface);
        if let Some(wl_surface_id) = wl_surface_id {
            fx.destroyed_surfaces.push(wl_surface_id);
        }
    }
    conn.purge(msg.object_id);
    Action::Forward
}

pub(crate) fn on_pointer_release(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    conn.purge(msg.object_id);
    Action::Forward
}

pub(crate) fn on_output_release(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    // There is no event to wait for before the object stops being nameable:
    // `release` is a destructor, so the id is meaningless from the moment the
    // request is forwarded. Drop the mapping now, not at `delete_id`, or a
    // layer surface created in between would name a destroyed output.
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
            // A reserved id: the client owns an object under it that the
            // compositor was never allowed to create, and this is the callback
            // that reserved it being consumed. The id is the client's, never
            // ours — recycling it would hand the same id to both sides at once.
            if let Some(reservation) = conn.reservations.get_mut(&dead) {
                reservation.callback_done = true;
                if reservation.client_done {
                    // The client is already done with its object, so this answer
                    // is exactly the release it is waiting for.
                    conn.reservations.remove(&dead);
                    return Action::Forward;
                }
                // The client is still using it. The events of the callback are
                // hidden until it answers, which it just did; the release waits
                // for the client's own destroy.
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
        if conn.stolen_ids.contains(&dead) {
            // Keep reserved IDs hidden from the client without recycling twice.
            return Action::Suppress;
        }
        if conn.stolen_ids.len() < 32 {
            conn.stolen_ids.push(dead);
            return Action::Suppress;
        }
    }
    Action::Forward
}

#[cfg(test)]
mod deleted_id_tests {
    use super::super::super::test_support::message;
    use super::*;

    fn recycle(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
        on_delete_id(conn, msg)
    }

    #[test]
    fn a_reserved_id_is_not_recycled_twice_or_returned_to_the_client() {
        let mut conn = WaylandConn::new();
        let deleted = message(1, 1, &42_u32.to_ne_bytes());
        assert!(matches!(recycle(&mut conn, &deleted), Action::Suppress));
        assert!(matches!(recycle(&mut conn, &deleted), Action::Suppress));
        assert_eq!(conn.stolen_ids, vec![42]);
    }

    #[test]
    fn a_full_pool_still_suppresses_duplicates_but_forwards_new_ids() {
        let mut conn = WaylandConn::new();
        conn.stolen_ids = (10..42).collect();
        let duplicate = message(1, 1, &10_u32.to_ne_bytes());
        assert!(matches!(recycle(&mut conn, &duplicate), Action::Suppress));
        let new_id = message(1, 1, &42_u32.to_ne_bytes());
        assert!(matches!(recycle(&mut conn, &new_id), Action::Forward));
        assert_eq!(conn.stolen_ids.len(), 32);
    }
}

#[cfg(test)]
mod popup_shadow_tests {
    use super::super::super::test_support::{message, request};
    use super::*;

    #[test]
    fn positioner_uses_content_size_and_preserves_the_anchor() {
        use super::super::super::{
            codec::{REQ_GET_TOPLEVEL, decode},
            state,
        };
        state::init_state();
        let fd = 94_101;
        state::clear_runtime_state_for_fd(fd);
        state::insert_popup_policy_for_test(
            fd,
            "shadow-menu",
            "shadow-parent",
            280,
            329,
            24,
            Some((70, 80)),
        );
        let mut conn = WaylandConn::new();
        conn.xdg_wm_base_id = Some(2);
        // The parent the policy names has to be resolvable on this connection.
        conn.surface_ids.insert(20, "shadow-parent".into());
        conn.xdg_to_wl.insert(19, 20);
        conn.stolen_ids.push(900);
        let msg = WlMessage::new(
            40,
            REQ_GET_TOPLEVEL,
            request(40, REQ_GET_TOPLEVEL, 12, &[50]),
        );
        let Action::Replace(out) = on_get_toplevel(fd, &mut conn, &msg, Some("shadow-menu")) else {
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
