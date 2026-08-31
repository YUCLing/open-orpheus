//! Wayland functionality: the interception/injection rules.
//!
//! Each rule lives in its own submodule and is a small function of
//! `(&mut WaylandConn, &WlMessage)` returning an [`Action`]. The dispatch
//! tables below are the single index of every intercept point.

mod objects;
mod pointer;
mod title;

use std::os::fd::RawFd;

use super::codec::{
    EVT_DELETE_ID, Iface, REQ_BIND, REQ_CREATE_SURFACE, REQ_DESTROY, REQ_GET_POINTER,
    REQ_GET_REGISTRY, REQ_GET_TOPLEVEL, REQ_GET_XDG_SURFACE, REQ_SET_TITLE, WL_POINTER_RELEASE,
    WlMessage,
};
use super::state::WaylandConn;

/// What to do with a message after its handler ran.
pub(crate) enum Action {
    /// Forward the message unchanged.
    Forward,
    /// Drop the message.
    Suppress,
    /// Replace the message with protocol-compatible synthesized bytes.
    Replace(Vec<u8>),
}

/// Side effects a handler wants applied *after* the connection lock is
/// released (global state updates / user callbacks).
#[derive(Default)]
pub(crate) struct Effects {
    pub(crate) button: Option<(u32, u32, u32, i32, i32)>,
    pub(crate) entered: Option<(u32, i32, i32)>,
    pub(crate) arm_watchers_for: Option<u32>,
    pub(crate) pointer_axis: bool,
}

pub(crate) fn dispatch_request(
    fd: RawFd,
    conn: &mut WaylandConn,
    msg: &WlMessage,
    fx: &mut Effects,
) -> Action {
    let Some(iface) = conn.ifaces.get(&msg.object_id).copied() else {
        return Action::Forward;
    };

    match (iface, msg.opcode) {
        (Iface::WlDisplay, REQ_GET_REGISTRY) => objects::on_get_registry(conn, msg),
        (Iface::WlRegistry, REQ_BIND) => objects::on_bind(conn, msg),
        (Iface::WlCompositor, REQ_CREATE_SURFACE) => objects::on_create_surface(conn, msg),
        (Iface::WlSeat, REQ_GET_POINTER) => objects::on_get_pointer(conn, msg),
        (Iface::XdgWmBase, REQ_GET_XDG_SURFACE) => objects::on_get_xdg_surface(conn, msg),
        (Iface::XdgSurface, REQ_GET_TOPLEVEL) => objects::on_get_toplevel(fd, conn, msg, fx),
        (Iface::XdgToplevel, REQ_SET_TITLE) => title::on_set_title(fd, conn, msg),
        (Iface::XdgPopupShim, REQ_SET_TITLE) => {
            let _ = title::on_set_title(fd, conn, msg);
            Action::Suppress
        }
        (Iface::XdgPopupShim, REQ_DESTROY) => objects::on_destroy(fd, conn, msg),
        (Iface::XdgPopupShim, _) => Action::Suppress,
        (Iface::WlSurface | Iface::XdgSurface | Iface::XdgToplevel, REQ_DESTROY) => {
            objects::on_destroy(fd, conn, msg)
        }
        (Iface::WlPointer, WL_POINTER_RELEASE) => objects::on_pointer_release(conn, msg),
        _ => Action::Forward,
    }
}

pub(crate) fn dispatch_event(conn: &mut WaylandConn, msg: &WlMessage, fx: &mut Effects) -> Action {
    if msg.object_id == 1 && msg.opcode == EVT_DELETE_ID {
        return objects::on_delete_id(conn, msg);
    }

    if conn.ifaces.get(&msg.object_id) == Some(&Iface::WlPointer) {
        return pointer::on_pointer_event(conn, msg, fx);
    }

    if conn.ifaces.get(&msg.object_id) == Some(&Iface::XdgPopupShim) {
        return objects::on_popup_event(msg);
    }

    Action::Forward
}
