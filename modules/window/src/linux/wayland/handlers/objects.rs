//! Object-graph tracking: registry binds, surface/pointer/xdg creation,
//! destruction, and `delete_id` ID stealing.

use std::os::fd::RawFd;

use super::super::codec::{Iface, WlMessage};
use super::super::state::{CUSTOM_ID_MAP, WaylandConn};
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
            "xdg_wm_base" => Some(Iface::XdgWmBase),
            "zxdg_decoration_manager_v1" => Some(Iface::ZxdgDecorationManager),
            "xdg_toplevel_icon_manager_v1" => Some(Iface::XdgToplevelIconManager),
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

pub(crate) fn on_get_toplevel(conn: &mut WaylandConn, msg: &WlMessage, fx: &mut Effects) -> Action {
    if let Some(top_id) = msg.u32_arg(8) {
        conn.ifaces.insert(top_id, Iface::XdgToplevel);
        conn.top_to_xdg.insert(top_id, msg.object_id);
        if let Some(wl_id) = conn.xdg_to_wl.get(&msg.object_id).copied() {
            conn.wl_to_top.insert(wl_id, top_id);
            // The surface is a toplevel for good: a compositor never releases
            // the role, so it can never become a layer surface.
            conn.toplevel_surfaces.insert(wl_id);
            fx.arm_watchers_for = Some(wl_id);
        }
    }
    Action::Forward
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
        if conn.stolen_ids.len() < 32 && !conn.stolen_ids.contains(&dead) {
            conn.stolen_ids.push(dead);
            return Action::Suppress;
        }
    }
    Action::Forward
}
