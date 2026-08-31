//! Object-graph tracking: registry binds, surface/pointer/xdg creation,
//! destruction, and `delete_id` ID stealing.

use std::os::fd::RawFd;

use super::super::codec::{Iface, WlMessage};
use super::super::state::{CUSTOM_ID_MAP, WaylandConn, take_pending_popup};
use super::{Action, Effects};

pub(crate) fn on_get_registry(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    if let Some(new_id) = msg.u32_arg(8) {
        conn.ifaces.insert(new_id, Iface::WlRegistry);
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
        if let Some(popup) = take_pending_popup(fd)
            && let Some(wm_base_id) = conn.xdg_wm_base_id
        {
            let positioner_id = popup.positioner_id;
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
                &[popup.width, popup.height],
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

            conn.ifaces.insert(positioner_id, Iface::XdgPositioner);
            conn.ifaces.insert(top_id, Iface::XdgPopupShim);
            conn.top_to_xdg.insert(top_id, msg.object_id);
            if let Some(wl_id) = conn.xdg_to_wl.get(&msg.object_id).copied() {
                conn.wl_to_top.insert(wl_id, top_id);
                fx.arm_watchers_for = Some(wl_id);
            }
            return Action::Replace(replacement);
        }
        conn.ifaces.insert(top_id, Iface::XdgToplevel);
        conn.top_to_xdg.insert(top_id, msg.object_id);
        if let Some(wl_id) = conn.xdg_to_wl.get(&msg.object_id).copied() {
            conn.wl_to_top.insert(wl_id, top_id);
            fx.arm_watchers_for = Some(wl_id);
        }
    }
    Action::Forward
}

pub(crate) fn on_popup_event(msg: &WlMessage) -> Action {
    match msg.opcode {
        // Translate xdg_popup.configure(x, y, width, height) into the
        // xdg_toplevel.configure(width, height, states[]) Chromium expects.
        0 => {
            let (Some(width), Some(height)) = (msg.u32_arg(16), msg.u32_arg(20)) else {
                return Action::Suppress;
            };
            let mut replacement = Vec::with_capacity(20);
            push_message(
                &mut replacement,
                msg.object_id,
                0,
                &[width as i32, height as i32, 0],
            );
            Action::Replace(replacement)
        }
        1 => Action::Forward,  // popup_done has the same wire shape as close
        _ => Action::Suppress, // repositioned has no toplevel equivalent
    }
}

pub(crate) fn on_destroy(fd: RawFd, conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    if let Some(iface) = conn.ifaces.get(&msg.object_id).copied()
        && let Some(wl_surface_id) = conn.wl_surface_for_window_object(msg.object_id, iface)
        && let Some(m) = CUSTOM_ID_MAP.get()
        && let Ok(mut map) = m.lock()
    {
        map.retain(|_, v| !(v.0 == fd && v.1 == wl_surface_id));
    }
    conn.purge(msg.object_id);
    Action::Forward
}

pub(crate) fn on_pointer_release(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    conn.purge(msg.object_id);
    Action::Forward
}

pub(crate) fn on_delete_id(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    if let Some(dead) = msg.u32_arg(8) {
        conn.purge(dead);

        // If it's one of our injected IDs, we're done with it — recycle it.
        if conn.injected_ids.remove(&dead) {
            conn.stolen_ids.push(dead);
            return Action::Suppress;
        }

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
