//! Role transactions: deciding a surface's role exactly once.
//!
//! A role has to be assigned before its title can be sent, so the managed
//! window is unknown when the client asks for its toplevel. A compositor keeps
//! a surface's role for the surface's whole life, so the decision can be made
//! once and re-applied to every later role object on that surface.
//!
//! The block opens with `get_xdg_surface`, which is held too: a compositor may
//! claim the surface's role there rather than in `get_toplevel` (wlroots does,
//! KWin does not), and a layer conversion needs that role to still be free.
//! When the outcome is not a layer surface the held creation is emitted first,
//! so the compositor's object map matches the client's.
//!
//! Only the role's own requests are held. Anything else completes the
//! transaction first and is then dispatched normally: a request that creates a
//! new object id must not reach the compositor before the `get_toplevel` this
//! transaction holds, and a request can also carry a file descriptor, which
//! travels with the message and cannot be stored in a byte buffer. The
//! transaction ends at the title, the commit, the destruction of the role
//! object or its surface, or a message cap.

use std::os::fd::RawFd;

use super::super::codec::{
    Iface, REQ_COMMIT, REQ_DESTROY, REQ_GET_TOPLEVEL, REQ_GET_TOPLEVEL_DECORATION,
    REQ_GET_XDG_SURFACE, REQ_SET_ICON, REQ_SET_TITLE, WlMessage, parse_custom_title,
};
use super::super::layer_shell;
use super::super::state::{
    Reservation, SurfaceRole, WaylandConn, layer_policy, role_decision_needed,
};
use super::{Action, Effects, conversion, dispatch_request_inner, objects};

/// Most messages one transaction may sweep before it is decided anyway.
const MAX_SWEPT_ROLE_REQUESTS: usize = 32;

/// A `get_xdg_surface` held while the window identity is still unknown.
///
/// The role belongs to the `wl_surface`, and it is claimed by whichever request
/// the compositor assigns it in. wlroots-based compositors claim it here, in
/// `xdg_wm_base.get_xdg_surface` — not at `get_toplevel`, which is the request
/// this proxy replaces. Letting it through would therefore make the later layer
/// conversion a fatal "surface already has a role" error there, so it waits
/// with the rest of the client's block.
pub(crate) struct PendingXdgSurface {
    xdg_surface: u32,
    wl_surface: u32,
    msg: WlMessage,
}

impl PendingXdgSurface {
    /// Whether this hold is about `id`, either the surface or its wl_surface.
    pub(crate) fn concerns(&self, id: u32) -> bool {
        self.xdg_surface == id || self.wl_surface == id
    }
}

/// A role the client is building and the proxy has not decided yet.
pub(crate) struct PendingRole {
    xdg_surface: u32,
    wl_surface: u32,
    /// The client's id for the `xdg_toplevel` it is building, reused as the
    /// layer surface id when the role is converted.
    toplevel: u32,
    toplevel_msg: WlMessage,
    /// The `get_xdg_surface` that opened this surface, when it was held.
    ///
    /// A layer conversion drops it: the compositor must never create the
    /// client's `xdg_surface`, or the surface's role is spent before the layer
    /// role can be claimed. Every other outcome emits it first.
    xdg_surface_msg: Option<WlMessage>,
    /// The managed window id the decorated title named, once it was seen.
    marker: Option<String>,
    /// Requests belonging to this role that arrived while it was held.
    swept: Vec<WlMessage>,
    /// Decoration objects introduced by this role's swept requests.
    decoration_ids: Vec<u32>,
}

impl PendingRole {
    fn new(
        xdg_surface: u32,
        wl_surface: u32,
        toplevel: u32,
        msg: &WlMessage,
        xdg_surface_msg: Option<WlMessage>,
    ) -> Self {
        Self {
            xdg_surface,
            wl_surface,
            toplevel,
            toplevel_msg: WlMessage::new(msg.object_id, msg.opcode, msg.raw().to_vec()),
            xdg_surface_msg,
            marker: None,
            swept: Vec::new(),
            decoration_ids: Vec::new(),
        }
    }
}

pub(crate) fn dispatch(
    fd: RawFd,
    conn: &mut WaylandConn,
    msg: &WlMessage,
    fx: &mut Effects,
) -> Action {
    // A held `get_xdg_surface` opens the role the client is building only when
    // the very next request asks for that surface's toplevel. Anything else
    // means this is not the block shape the hold assumes, so the creation is
    // released rather than left dangling: the window simply keeps an ordinary
    // role instead of becoming an unconvertible one.
    if let Some(parked) = conn.pending_xdg_surface.take() {
        if msg.object_id == parked.xdg_surface && msg.opcode == REQ_GET_TOPLEVEL {
            return begin_role(fd, conn, msg, fx, Some(parked.msg));
        }
        // Releasing the creation means the compositor is about to create the
        // client's xdg_surface, and on compositors that claim the surface's
        // role there (wlroots) the surface can never take the layer role
        // afterwards. Record that, or the decision at the title would still try
        // to convert it and kill the connection.
        let mut out = Vec::new();
        if matches!(
            conn.surface_roles.get(&parked.wl_surface),
            Some(SurfaceRole::Layer(_))
        ) {
            // This surface has been a layer surface, and the role sticks to the
            // wl_surface for its whole life: asking it for any other role is the
            // protocol error the conversion exists to avoid. The creation must
            // not be forwarded, so the id is reserved and the surface stays
            // virtual; the cached decision is left alone, and a later show
            // retries it.
            reserve_id(conn, &mut out, parked.xdg_surface);
        } else {
            // Otherwise the compositor is about to create the client's
            // xdg_surface, and on compositors that claim the surface's role
            // there (wlroots) the surface can never take the layer role
            // afterwards. Record that, or the decision at the title would still
            // try to convert it and kill the connection.
            conn.surface_roles
                .insert(parked.wl_surface, SurfaceRole::Toplevel { reported: false });
            out.push(parked.msg.raw().to_vec());
        }
        append_action(&mut out, msg, dispatch(fd, conn, msg, fx));
        return Action::Replace(out);
    }

    if conn.pending_role.is_some() {
        return continue_role(fd, conn, msg, fx);
    }
    if conn.ifaces.get(&msg.object_id) == Some(&Iface::XdgWmBase)
        && msg.opcode == REQ_GET_XDG_SURFACE
    {
        return hold_xdg_surface(fd, conn, msg, fx);
    }
    if conn.ifaces.get(&msg.object_id) == Some(&Iface::XdgSurface) && msg.opcode == REQ_GET_TOPLEVEL
    {
        return begin_role(fd, conn, msg, fx, None);
    }
    dispatch_request_inner(fd, conn, msg, fx)
}

/// Hold `get_xdg_surface` until the window identity decides the surface's role.
fn hold_xdg_surface(
    fd: RawFd,
    conn: &mut WaylandConn,
    msg: &WlMessage,
    fx: &mut Effects,
) -> Action {
    let (Some(xdg_surface), Some(wl_surface)) = (msg.u32_arg(8), msg.u32_arg(12)) else {
        return dispatch_request_inner(fd, conn, msg, fx);
    };
    if !role_may_still_change(conn, fd, wl_surface) {
        return dispatch_request_inner(fd, conn, msg, fx);
    }
    // The mapping the role decision needs, recorded exactly as forwarding does.
    let _ = objects::on_get_xdg_surface(conn, msg);
    conn.pending_xdg_surface = Some(PendingXdgSurface {
        xdg_surface,
        wl_surface,
        msg: WlMessage::new(msg.object_id, msg.opcode, msg.raw().to_vec()),
    });
    Action::Suppress
}

/// Whether a role creation on this surface could still change its role.
///
/// A layer policy registered anywhere may apply to the window this surface is
/// about to belong to — and a surface that is already a layer surface converts
/// again on every show, even after the policy was withdrawn, because the
/// decision is cached on the surface.
fn role_may_still_change(conn: &WaylandConn, fd: RawFd, wl_surface: u32) -> bool {
    role_decision_needed(fd)
        || matches!(
            conn.surface_roles.get(&wl_surface),
            Some(SurfaceRole::Layer(_))
        )
}

/// Reserve the id of a client object the compositor must not create.
///
/// A suppressed `new_id` leaves a hole in the compositor's object map at the
/// edge it is still growing, and the next id the client allocates is refused
/// outright, which takes the whole connection down. A callback occupies the id
/// without claiming anything, and the proxy answers for the object from its own
/// tables for the object's whole life — the callback is gone from the
/// compositor long before the client is done with it.
fn reserve_id(conn: &mut WaylandConn, out: &mut Vec<Vec<u8>>, id: u32) {
    out.push(layer_shell::sync_callback(id));
    conn.injected_ids.insert(id);
    conn.reservations.insert(id, Reservation::default());
}

/// Emit a held `get_xdg_surface` in front of whatever `action` produced.
///
/// Used whenever the hold turns out not to be a layer conversion: the
/// compositor still has to create the client's `xdg_surface`, and it has to
/// exist before the request that names it.
fn release_then(parked: Option<WlMessage>, msg: &WlMessage, action: Action) -> Action {
    let Some(parked) = parked else {
        return action;
    };
    let mut out = vec![parked.raw().to_vec()];
    append_action(&mut out, msg, action);
    Action::Replace(out)
}

/// Answer `get_toplevel`: re-apply a role already decided for this surface,
/// open a transaction when the window identity could still change it, or
/// forward it as an ordinary toplevel.
fn begin_role(
    fd: RawFd,
    conn: &mut WaylandConn,
    msg: &WlMessage,
    fx: &mut Effects,
    xdg_surface_msg: Option<WlMessage>,
) -> Action {
    let xdg_surface = msg.object_id;
    let Some(wl_surface) = conn.xdg_to_wl.get(&xdg_surface).copied() else {
        return release_then(
            xdg_surface_msg,
            msg,
            dispatch_request_inner(fd, conn, msg, fx),
        );
    };
    let Some(toplevel) = msg.u32_arg(8) else {
        return release_then(
            xdg_surface_msg,
            msg,
            dispatch_request_inner(fd, conn, msg, fx),
        );
    };
    if conn.surface_roles.contains_key(&wl_surface) {
        // The role is settled for this surface: re-apply it without waiting for
        // the title again.
        let pending = PendingRole::new(xdg_surface, wl_surface, toplevel, msg, xdg_surface_msg);
        return Action::Replace(flush_role(fd, conn, &pending, fx));
    }
    if !role_decision_needed(fd) {
        return release_then(
            xdg_surface_msg,
            msg,
            dispatch_request_inner(fd, conn, msg, fx),
        );
    }
    conn.pending_role = Some(PendingRole::new(
        xdg_surface,
        wl_surface,
        toplevel,
        msg,
        xdg_surface_msg,
    ));
    Action::Suppress
}

/// Sweep one message while a role transaction is open, and decide it when
/// something makes the identity irrelevant or the block has to end.
fn continue_role(fd: RawFd, conn: &mut WaylandConn, msg: &WlMessage, fx: &mut Effects) -> Action {
    let Some(mut pending) = conn.pending_role.take() else {
        return dispatch_request_inner(fd, conn, msg, fx);
    };

    // The decorated title names the managed window, so the role can be decided
    // as soon as it arrives instead of waiting for the commit.
    if msg.object_id == pending.toplevel
        && msg.opcode == REQ_SET_TITLE
        && let Some((id, _)) = msg.str_text(8).and_then(parse_custom_title)
    {
        pending.marker = Some(id.to_string());
    }

    let is_commit = msg.object_id == pending.wl_surface
        && msg.opcode == REQ_COMMIT
        && conn.ifaces.get(&msg.object_id) == Some(&Iface::WlSurface);

    // A window cancelled before its title is gone: the role objects (or the
    // surface behind them) are being destroyed, so there is nothing left to
    // decide for. Ending the transaction here is what lets every later window
    // open one of its own.
    let abandons_role = msg.opcode == REQ_DESTROY
        && (msg.object_id == pending.toplevel
            || msg.object_id == pending.xdg_surface
            || (msg.object_id == pending.wl_surface
                && conn.ifaces.get(&msg.object_id) == Some(&Iface::WlSurface)));

    if belongs_to_role(conn, &mut pending, msg) {
        pending.swept.push(WlMessage::new(
            msg.object_id,
            msg.opcode,
            msg.raw().to_vec(),
        ));

        let decided = pending.marker.is_some()
            || is_commit
            || abandons_role
            || pending.swept.len() >= MAX_SWEPT_ROLE_REQUESTS;
        if !decided {
            conn.pending_role = Some(pending);
            return Action::Suppress;
        }

        return Action::Replace(flush_role(fd, conn, &pending, fx));
    }

    // Not part of the role. Complete the role first, so the held `get_toplevel`
    // and the object id it allocates reach the compositor before this request,
    // then let it take its normal path. It is never held: a request can carry
    // file descriptors, which travel with the message and cannot be kept in a
    // byte buffer; holding it would leave the replay with no descriptor to send.
    let mut out = flush_role(fd, conn, &pending, fx);
    append_action(&mut out, msg, dispatch(fd, conn, msg, fx));
    Action::Replace(out)
}

/// Whether `msg` belongs to the role being built.
///
/// Only these are ever held. None of them carries a file descriptor, which is
/// what makes holding them safe.
fn belongs_to_role(conn: &mut WaylandConn, pending: &mut PendingRole, msg: &WlMessage) -> bool {
    let toplevel = pending.toplevel;
    if msg.object_id == toplevel || msg.object_id == pending.xdg_surface {
        return true;
    }
    if msg.object_id == pending.wl_surface && matches!(msg.opcode, REQ_COMMIT | REQ_DESTROY) {
        return true;
    }
    if pending.decoration_ids.contains(&msg.object_id) {
        return true;
    }
    if conn.ifaces.get(&msg.object_id) == Some(&Iface::ZxdgDecorationManager)
        && msg.opcode == REQ_GET_TOPLEVEL_DECORATION
        && msg.u32_arg(12) == Some(toplevel)
    {
        if let Some(id) = msg.u32_arg(8) {
            pending.decoration_ids.push(id);
        }
        return true;
    }
    conn.ifaces.get(&msg.object_id) == Some(&Iface::XdgToplevelIconManager)
        && msg.opcode == REQ_SET_ICON
        && msg.u32_arg(8) == Some(toplevel)
}

/// Decide the role, emit it, and replay everything that was swept for it.
fn flush_role(
    fd: RawFd,
    conn: &mut WaylandConn,
    pending: &PendingRole,
    fx: &mut Effects,
) -> Vec<Vec<u8>> {
    let toplevel = pending.toplevel;
    let resolved = pending
        .marker
        .clone()
        .or_else(|| conn.surface_ids.get(&pending.wl_surface).cloned());
    let cached = conn.surface_roles.get(&pending.wl_surface).cloned();
    let policy = resolved.as_deref().and_then(layer_policy);

    // A surface that is already an ordinary toplevel can never take the layer
    // role: the compositor keeps the role for the surface's whole life and
    // answers the attempt with a fatal protocol error. Refuse, report once, and
    // leave the window an ordinary toplevel.
    let refused = matches!(cached, Some(SurfaceRole::Toplevel { .. })) && policy.is_some();
    if refused
        && let Some(SurfaceRole::Toplevel { reported }) =
            conn.surface_roles.get_mut(&pending.wl_surface)
        && !*reported
    {
        *reported = true;
        eprintln!(
            "[proxy:wayland] layer-shell refused: the window's surface is already an xdg_toplevel, so it cannot become a layer surface (re-create the window to apply it)"
        );
        fx.layer_shell_refused = resolved
            .clone()
            .or_else(|| conn.surface_ids.get(&pending.wl_surface).cloned());
    }

    let layer_options = match cached {
        Some(SurfaceRole::Layer(options)) => Some(options),
        Some(SurfaceRole::Toplevel { .. }) => None,
        None if !refused => policy,
        None => None,
    };
    let had_cached_role = conn.surface_roles.contains_key(&pending.wl_surface);

    let mut out = Vec::new();
    let mut converted = false;
    if let Some(options) = layer_options {
        if let Some(messages) = conversion::convert_to_layer_surface(
            conn,
            pending.xdg_surface,
            pending.wl_surface,
            toplevel,
            options,
        ) {
            // The client's xdg_surface never reaches the compositor, so reserve
            // its id with an object that does not claim the surface's role. A
            // suppressed `new_id` leaves a hole in the compositor's object map
            // at the edge it is still growing, and the layer surface's own id —
            // allocated right after it — is refused outright, which takes the
            // whole connection down.
            // The client's xdg_surface never reaches the compositor, so its id
            // is reserved for it — the layer surface's own id is allocated
            // right after it and would be refused if the map were left with a
            // hole.
            if pending.xdg_surface_msg.is_some() {
                reserve_id(conn, &mut out, pending.xdg_surface);
            }
            out.extend(messages);
            converted = true;
        } else if had_cached_role {
            // Already a layer surface and the conversion cannot be sent — the
            // compositor withdrew the global between shows, say. This surface
            // can never become anything else, so the role is *not* handed back
            // as an ordinary toplevel: every id the client allocated for the
            // block is reserved instead and left unused, and the cached
            // decision stays, so a later show retries the layer surface if the
            // compositor brings the global back.
            if pending.xdg_surface_msg.is_some() {
                reserve_id(conn, &mut out, pending.xdg_surface);
            }
            reserve_id(conn, &mut out, toplevel);
            // The client believes it has an xdg_toplevel there, and manager
            // requests name it as one: recording that is what lets them be
            // answered locally instead of forwarded to an object that does not
            // exist.
            conn.ifaces.insert(toplevel, Iface::XdgToplevel);
            for decoration in &pending.decoration_ids {
                reserve_id(conn, &mut out, *decoration);
            }
            return out;
        }
    }
    if !converted {
        // The compositor must never create the client's xdg_surface when the
        // role is a layer surface — that is what spends the surface's role
        // before the layer role can be claimed. Every other outcome has to
        // create it, before the request that names it.
        if let Some(parked) = &pending.xdg_surface_msg {
            out.push(parked.raw().to_vec());
        }
        append_action(
            &mut out,
            &pending.toplevel_msg,
            objects::on_get_toplevel(fd, conn, &pending.toplevel_msg, resolved.as_deref()),
        );
    }

    // Replay the role's own held requests through the normal dispatch, in
    // order, after the role decision they belong to.
    for swept in &pending.swept {
        append_action(&mut out, swept, dispatch(fd, conn, swept, fx));
    }
    out
}

fn append_action(out: &mut Vec<Vec<u8>>, msg: &WlMessage, action: Action) {
    match action {
        Action::Forward => out.push(msg.raw().to_vec()),
        Action::Suppress => {}
        Action::Replace(messages) => out.extend(messages),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::MutexGuard;

    use super::super::super::{
        codec::{
            DECORATION_CLIENT_SIDE, EVT_DECORATION_CONFIGURE, EVT_DELETE_ID, EVT_LAYER_CONFIGURE,
            REQ_ACK_CONFIGURE, REQ_BIND, REQ_COMMIT, REQ_DESTROY, REQ_GET_LAYER_SURFACE,
            REQ_GET_TOPLEVEL, REQ_GET_TOPLEVEL_DECORATION, REQ_GET_XDG_SURFACE,
            REQ_LAYER_ACK_CONFIGURE, REQ_LAYER_DESTROY, REQ_SET_ICON, REQ_SET_TITLE,
            decorate_title,
        },
        state::{self, SurfaceRole},
        test_support::{header, message, options, serial, u32_at, wl_string, word},
    };
    use super::*;

    /// `wl_callback.done`, the only event the callback that reserves an id
    /// sends, and the one a late arrival must never hand to the client.
    const EVT_CALLBACK_DONE: u16 = 0;

    /// A connection with a pending popup policy for `fd`, so a role transaction
    /// opens without registering a process-global layer policy.
    fn reserved(fd: RawFd) -> (MutexGuard<'static, ()>, WaylandConn) {
        let guard = serial();
        state::init_state();
        state::clear_all_layer_policies();
        state::clear_runtime_state_for_fd(fd);
        state::insert_popup_policy_for_test(
            fd,
            "menu-target",
            "menu-parent",
            100,
            80,
            0,
            Some((4, 5)),
        );
        let mut conn = WaylandConn::new();
        conn.xdg_wm_base_id = Some(2);
        conn.ifaces.insert(40, Iface::XdgSurface);
        conn.ifaces.insert(41, Iface::XdgSurface);
        conn.ifaces.insert(10, Iface::WlSurface);
        conn.xdg_to_wl.insert(40, 10);
        conn.xdg_to_wl.insert(41, 11);
        // The parent the popup names, on a surface of its own so it does not
        // disturb the surfaces the role cases use.
        conn.surface_ids.insert(99, "menu-parent".to_string());
        conn.xdg_to_wl.insert(98, 99);
        conn.registry_id = Some(5);
        conn.ifaces.insert(5, Iface::WlRegistry);
        conn.layer_shell_global = Some((63, 5));
        conn.stolen_ids.push(60);
        (guard, conn)
    }

    /// A reserved connection whose popup is withdrawn, so `role_decision_needed`
    /// is false unless some policy is registered.
    fn unreserved(fd: RawFd) -> (MutexGuard<'static, ()>, WaylandConn) {
        let (guard, conn) = reserved(fd);
        state::clear_popup_policy("menu-target");
        (guard, conn)
    }

    fn dispatch_and_collect(
        fd: RawFd,
        conn: &mut WaylandConn,
        msg: &WlMessage,
    ) -> (Vec<Vec<u8>>, Effects) {
        let mut fx = Effects::default();
        let mut out = Vec::new();
        append_action(&mut out, msg, dispatch(fd, conn, msg, &mut fx));
        (out, fx)
    }

    fn send(fd: RawFd, conn: &mut WaylandConn, msg: &WlMessage) -> Vec<Vec<u8>> {
        dispatch_and_collect(fd, conn, msg).0
    }

    #[test]
    fn a_get_toplevel_without_a_pending_decision_is_forwarded_untouched() {
        let fd = 94_000;
        let (_guard, mut conn) = unreserved(fd);
        assert!(!state::role_decision_needed(fd));

        let role = message(40, REQ_GET_TOPLEVEL, &word(50));
        let (out, _fx) = dispatch_and_collect(fd, &mut conn, &role);

        assert_eq!(out, vec![role.raw().to_vec()]);
        assert!(conn.pending_role.is_none());
        assert_eq!(conn.ifaces.get(&50), Some(&Iface::XdgToplevel));
        assert_eq!(conn.wl_to_top.get(&10), Some(&50));
        assert!(matches!(
            conn.surface_roles.get(&10),
            Some(SurfaceRole::Toplevel { .. })
        ));
    }

    #[test]
    fn commit_without_identity_flushes_an_ordinary_role_instead_of_guessing() {
        let fd = 94_001;
        let (_guard, mut conn) = reserved(fd);
        assert!(send(fd, &mut conn, &message(40, REQ_GET_TOPLEVEL, &word(50))).is_empty());
        let commit = message(10, REQ_COMMIT, &[]);
        let out = send(fd, &mut conn, &commit);
        assert_eq!(out[0], message(40, REQ_GET_TOPLEVEL, &word(50)).raw());
        assert_eq!(out[1], commit.raw());
        assert!(conn.pending_role.is_none());
        assert_eq!(conn.ifaces.get(&50), Some(&Iface::XdgToplevel));
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn a_foreign_message_is_held_until_the_role_is_decided() {
        let fd = 94_002;
        let (_guard, mut conn) = reserved(fd);
        assert!(send(fd, &mut conn, &message(40, REQ_GET_TOPLEVEL, &word(50))).is_empty());
        assert!(conn.pending_role.is_some());

        let foreign = message(77, 1, &word(1));
        let out = send(fd, &mut conn, &foreign);

        // The held creation goes out first, then the foreign request is
        // dispatched normally. It is never held: it may carry a file
        // descriptor, and the transport closes descriptors of a message the
        // proxy does not forward.
        assert_eq!(out[0], message(40, REQ_GET_TOPLEVEL, &word(50)).raw());
        assert_eq!(out[1], foreign.raw());
        assert!(conn.pending_role.is_none());
        assert_eq!(conn.ifaces.get(&50), Some(&Iface::XdgToplevel));
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn a_later_construction_is_sent_after_the_held_role() {
        let fd = 94_013;
        let (_guard, mut conn) = reserved(fd);
        let role = message(40, REQ_GET_TOPLEVEL, &word(50));
        assert!(send(fd, &mut conn, &role).is_empty());

        // `wl_display.sync(new_id)` allocates an id greater than the held
        // toplevel's; sending it first is exactly what the compositor refuses as
        // "not a valid new object id", so the role is completed first.
        let sync = message(1, 0, &word(70));
        let out = send(fd, &mut conn, &sync);

        assert_eq!(out[0], role.raw(), "the role reaches the compositor first");
        assert_eq!(out[1], sync.raw(), "then the construction behind it");
        assert!(conn.pending_role.is_none());
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn destroying_the_role_objects_ends_the_transaction_in_order() {
        let fd = 94_014;
        let (_guard, mut conn) = reserved(fd);
        let role = message(40, REQ_GET_TOPLEVEL, &word(50));
        assert!(send(fd, &mut conn, &role).is_empty());

        let destroy_toplevel = message(50, REQ_DESTROY, &[]);
        let out = send(fd, &mut conn, &destroy_toplevel);

        // The held creation is emitted first, so the destroy that follows it
        // names an object the compositor now has.
        assert_eq!(out[0], role.raw());
        assert_eq!(out[1], destroy_toplevel.raw());
        assert!(
            conn.pending_role.is_none(),
            "a window cancelled before its title releases the transaction"
        );
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn destroying_the_pending_surface_ends_the_transaction() {
        let fd = 94_015;
        let (_guard, mut conn) = reserved(fd);
        let role = message(40, REQ_GET_TOPLEVEL, &word(50));
        assert!(send(fd, &mut conn, &role).is_empty());

        let destroy_surface = message(10, REQ_DESTROY, &[]);
        let out = send(fd, &mut conn, &destroy_surface);

        assert_eq!(out[0], role.raw());
        assert_eq!(out[1], destroy_surface.raw());
        assert!(conn.pending_role.is_none());
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn a_decorated_title_resolves_the_marker_and_converts() {
        let fd = 94_003;
        let (_guard, mut conn) = reserved(fd);
        assert!(send(fd, &mut conn, &message(40, REQ_GET_TOPLEVEL, &word(50))).is_empty());
        assert!(
            conn.pending_role.is_some(),
            "the role waits for its window identity"
        );
        // The decided role supplies the options; seeding it here keeps this
        // test off the process-global policy map so it cannot race other tests.
        conn.surface_roles.insert(10, SurfaceRole::Layer(options()));

        let title = message(
            50,
            REQ_SET_TITLE,
            &wl_string(&decorate_title("layer-a", "Real")),
        );
        let out = send(fd, &mut conn, &title);

        // bind, get_layer_surface and the five state requests; the title itself
        // is swallowed because a layer surface has none.
        assert_eq!(out.len(), 7);
        assert_eq!(header(&out[0]).0, 5, "bound on the client's registry");
        assert_eq!(header(&out[0]).1, REQ_BIND);
        assert_eq!(header(&out[1]).0, 60, "the stolen shell id");
        assert_eq!(header(&out[1]).1, REQ_GET_LAYER_SURFACE);
        assert_eq!(u32_at(&out[1], 8), 50, "under the client's toplevel id");
        assert_eq!(u32_at(&out[1], 12), 10, "for the role's wl_surface");
        // The layer surface replaces the toplevel, while the xdg_surface the
        // client still owns stays real.
        assert_eq!(conn.ifaces.get(&50), Some(&Iface::ZwlrLayerSurface));
        assert_eq!(conn.ifaces.get(&40), Some(&Iface::XdgSurface));
        assert_eq!(conn.xdg_to_layer.get(&40), Some(&50));
        assert_eq!(conn.wl_to_layer.get(&10), Some(&50));
        assert_eq!(conn.layer_windows.get(&50).map(|w| w.wl_surface), Some(10));
        assert_eq!(conn.layer_windows.get(&50).map(|w| w.xdg_surface), Some(40));
        assert!(matches!(
            conn.surface_roles.get(&10),
            Some(SurfaceRole::Layer(cached)) if *cached == options()
        ));
        assert!(conn.pending_role.is_none());
        // The swallowed title still named the surface for later lookups.
        assert_eq!(
            conn.surface_ids.get(&10).map(String::as_str),
            Some("layer-a")
        );
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn pre_marker_decoration_and_icon_are_swept_and_shadowed_after_conversion() {
        let fd = 94_004;
        let (_guard, mut conn) = reserved(fd);
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
        // The decided role supplies the options; seeding it here keeps this
        // test off the process-global policy map so it cannot race other tests.
        conn.surface_roles.insert(10, SurfaceRole::Layer(options()));
        // An unadorned title must not assign the role prematurely.
        assert!(send(fd, &mut conn, &message(50, REQ_SET_TITLE, &wl_string(""))).is_empty());
        assert!(conn.pending_role.is_some());

        let out = send(
            fd,
            &mut conn,
            &message(
                50,
                REQ_SET_TITLE,
                &wl_string(&decorate_title("layer-a", "Menu")),
            ),
        );

        assert_eq!(conn.ifaces.get(&50), Some(&Iface::ZwlrLayerSurface));
        assert_eq!(conn.ifaces.get(&60), Some(&Iface::ZxdgToplevelDecoration));
        assert_eq!(conn.pending_to_client.len(), 1);
        // No request typed as xdg_toplevel may reach the compositor after the
        // role became a layer surface; the decoration is answered client-side.
        assert!(
            !out.iter()
                .any(|raw| raw == decoration.raw() || raw == mode.raw() || raw == icon.raw())
        );
        let event = &conn.pending_to_client[0];
        assert_eq!(header(event), (60, EVT_DECORATION_CONFIGURE, 12));
        assert_eq!(u32_at(event, 8), DECORATION_CLIENT_SIDE);

        // The stub decoration lives on until the client destroys it.
        assert!(send(fd, &mut conn, &message(60, REQ_DESTROY, &[])).is_empty());
        assert!(!conn.ifaces.contains_key(&60));
        assert!(!conn.injected_ids.contains(&60));
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn foreign_window_cannot_consume_popup_and_initial_requests_keep_order() {
        let fd = 94_005;
        let (_guard, mut conn) = reserved(fd);
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
            state::popup_policy("menu-target").is_some(),
            "another window cannot consume it"
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
            state::popup_policy("menu-target").is_none(),
            "the popup consumed its own policy"
        );
        assert!(conn.pending_role.is_none());
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn cancellation_before_title_does_not_convert_a_destroyed_menu() {
        let fd = 94_006;
        let (_guard, mut conn) = reserved(fd);
        assert!(send(fd, &mut conn, &message(40, REQ_GET_TOPLEVEL, &word(50))).is_empty());
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
        assert!(conn.pending_role.is_none());
    }

    #[test]
    fn cancellation_with_queued_decoration_preserves_an_ordinary_window() {
        let fd = 94_007;
        let (_guard, mut conn) = reserved(fd);
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
        assert!(conn.pending_role.is_none());
        assert!(conn.pending_to_client.is_empty());
    }

    #[test]
    fn a_swept_decoration_destroy_is_replayed_in_order() {
        let fd = 94_008;
        let (_guard, mut conn) = reserved(fd);
        conn.ifaces.insert(7, Iface::ZxdgDecorationManager);
        let role = message(40, REQ_GET_TOPLEVEL, &word(50));
        let decoration = message(
            7,
            REQ_GET_TOPLEVEL_DECORATION,
            &[word(60), word(50)].concat(),
        );
        let destroy = message(60, REQ_DESTROY, &[]);
        assert!(send(fd, &mut conn, &role).is_empty());
        assert!(send(fd, &mut conn, &decoration).is_empty());
        // A destroy is swept with the role it belongs to; it does not decide the
        // transaction by itself.
        assert!(send(fd, &mut conn, &destroy).is_empty());
        assert!(conn.pending_role.is_some());

        let commit = message(10, REQ_COMMIT, &[]);
        let out = send(fd, &mut conn, &commit);
        assert_eq!(
            out,
            vec![
                role.raw().to_vec(),
                decoration.raw().to_vec(),
                destroy.raw().to_vec(),
                commit.raw().to_vec()
            ]
        );
        assert_eq!(conn.ifaces.get(&50), Some(&Iface::XdgToplevel));
        assert!(conn.pending_role.is_none());
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn an_icon_for_another_window_completes_the_role_first() {
        let fd = 94_009;
        let (_guard, mut conn) = reserved(fd);
        conn.ifaces.insert(8, Iface::XdgToplevelIconManager);
        let role = message(40, REQ_GET_TOPLEVEL, &word(50));
        assert!(send(fd, &mut conn, &role).is_empty());
        // set_icon names toplevel 51, not the role's 50.
        let foreign = message(8, REQ_SET_ICON, &[word(51), word(70)].concat());
        let out = send(fd, &mut conn, &foreign);

        // The role is completed and emitted first; the icon then takes its
        // normal path, unshadowed by the transaction.
        assert_eq!(out[0], role.raw());
        assert_eq!(out[1], foreign.raw());
        assert!(conn.pending_role.is_none());
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn a_converted_window_never_gets_its_xdg_surface() {
        let fd = 94_016;
        let (_guard, mut conn) = reserved(fd);
        conn.ifaces.insert(2, Iface::XdgWmBase);
        conn.surface_roles.insert(10, SurfaceRole::Layer(options()));

        // The client's block opens with `get_xdg_surface`, which claims the
        // surface's role on compositors that assign it there.
        let create = message(2, REQ_GET_XDG_SURFACE, &[word(40), word(10)].concat());
        assert!(
            send(fd, &mut conn, &create).is_empty(),
            "held with the rest of the block"
        );

        let out = send(fd, &mut conn, &message(40, REQ_GET_TOPLEVEL, &word(50)));

        // The id of the creation that was dropped is reserved with a callback
        // before the layer surface asks for its own, or the compositor refuses
        // that one for skipping an id its object map has not grown to yet.
        assert_eq!(
            out[0],
            message(1, 0, &word(40)).raw(),
            "the dropped id is reserved first"
        );
        assert!(conn.injected_ids.contains(&40));
        assert!(conn.reservations.contains_key(&40));

        // The role is claimed on the shell object the proxy bound for itself.
        // Objects are checked with the opcode, because opcodes alone are
        // ambiguous across interfaces.
        assert!(
            out.iter()
                .any(|m| header(m).0 == 60 && header(m).1 == REQ_GET_LAYER_SURFACE),
            "the layer role is claimed"
        );
        assert!(
            out.iter()
                .all(|m| !(header(m).0 == 2 && header(m).1 == REQ_GET_XDG_SURFACE)),
            "the compositor must not create the client's xdg_surface, or the \
             surface's role is spent before the layer role can be claimed"
        );
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn a_converted_window_closes_without_naming_a_missing_xdg_surface() {
        let fd = 94_019;
        let (_guard, mut conn) = reserved(fd);
        conn.ifaces.insert(2, Iface::XdgWmBase);
        conn.surface_roles.insert(10, SurfaceRole::Layer(options()));

        assert!(
            send(
                fd,
                &mut conn,
                &message(2, REQ_GET_XDG_SURFACE, &[word(40), word(10)].concat())
            )
            .is_empty()
        );
        let converted = send(fd, &mut conn, &message(40, REQ_GET_TOPLEVEL, &word(50)));
        assert!(converted.iter().any(|m| header(m).0 == 60));

        // The compositor consumes the callback that reserved the id as soon as
        // it answers it — during the window's life, not at its teardown. That
        // answer is not the client's to see: the tables that translate this
        // window have to outlive it.
        let body = [word(7), word(300), word(200)].concat();
        let configure = message(50, EVT_LAYER_CONFIGURE, &body);
        let consumed = super::super::dispatch_event(
            &mut conn,
            &message(1, EVT_DELETE_ID, &word(40)),
            &mut Effects::default(),
        );
        assert!(
            matches!(consumed, Action::Suppress),
            "not the client's id to free"
        );
        assert!(conn.xdg_to_layer.contains_key(&40), "the mapping survives");
        assert!(conn.layer_windows.contains_key(&50));

        // So a configure still reaches the client as an xdg one, and its ack
        // still reaches the compositor as a layer one.
        let mut events = Vec::new();
        let action = super::super::dispatch_event(&mut conn, &configure, &mut Effects::default());
        append_action(&mut events, &configure, action);
        assert!(!events.is_empty(), "the configure is still translated");
        let acked = send(fd, &mut conn, &message(40, REQ_ACK_CONFIGURE, &word(7)));
        assert_eq!(header(&acked[0]), (50, REQ_LAYER_ACK_CONFIGURE, 12));

        // The client closes in its own order: the toplevel first, which is what
        // the layer surface is destroyed through.
        let toplevel = send(fd, &mut conn, &message(50, REQ_DESTROY, &[]));
        assert_eq!(header(&toplevel[0]), (50, REQ_LAYER_DESTROY, 8));

        // Then the surface. The compositor has had no object under that id since
        // it consumed the callback, so nothing is sent for it — and the client
        // is finally told the id is free, now that it is done with it.
        let out = send(fd, &mut conn, &message(40, REQ_DESTROY, &[]));
        assert!(out.is_empty(), "nothing reaches the compositor");
        assert_eq!(
            conn.pending_to_client,
            vec![message(1, EVT_DELETE_ID, &word(40)).raw()]
        );
        assert!(!conn.reservations.contains_key(&40));
        assert!(!conn.injected_ids.contains(&40));
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn a_window_that_closes_before_the_callback_answers_is_released_once() {
        let fd = 94_024;
        let (_guard, mut conn) = reserved(fd);
        conn.ifaces.insert(2, Iface::XdgWmBase);
        conn.surface_roles.insert(10, SurfaceRole::Layer(options()));

        assert!(
            send(
                fd,
                &mut conn,
                &message(2, REQ_GET_XDG_SURFACE, &[word(40), word(10)].concat())
            )
            .is_empty()
        );
        let converted = send(fd, &mut conn, &message(40, REQ_GET_TOPLEVEL, &word(50)));
        assert!(converted.iter().any(|m| header(m).0 == 60));

        // The window closes before the compositor has even answered the
        // callback that reserved the id. Nothing may be handed to the client
        // yet: the callback's own events are still on their way, and the id
        // must not go back while they are.
        let out = send(fd, &mut conn, &message(40, REQ_DESTROY, &[]));
        assert!(out.is_empty());
        assert!(conn.pending_to_client.is_empty(), "not released yet");
        assert!(
            conn.injected_ids.contains(&40),
            "its events are still hidden"
        );

        // The callback answers now. Its `done` is nobody's business...
        let done = message(40, EVT_CALLBACK_DONE, &word(7));
        let hidden = super::super::dispatch_event(&mut conn, &done, &mut Effects::default());
        assert!(
            matches!(hidden, Action::Suppress),
            "a late callback event must not reach a reused id"
        );

        // ...and its `delete_id` is exactly the release the client is waiting
        // for. It must not be recycled: the id is the client's.
        let freed = super::super::dispatch_event(
            &mut conn,
            &message(1, EVT_DELETE_ID, &word(40)),
            &mut Effects::default(),
        );
        assert!(matches!(freed, Action::Forward), "the client is told");
        assert!(!conn.reservations.contains_key(&40));
        assert!(!conn.injected_ids.contains(&40));
        assert!(!conn.stolen_ids.contains(&40), "never handed to us");
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn a_reserved_toplevel_answers_manager_requests() {
        let fd = 94_025;
        let (_guard, mut conn) = reserved(fd);
        conn.ifaces.insert(2, Iface::XdgWmBase);
        conn.ifaces.insert(70, Iface::ZxdgDecorationManager);
        conn.ifaces.insert(71, Iface::XdgToplevelIconManager);
        conn.surface_roles.insert(10, SurfaceRole::Layer(options()));
        conn.layer_shell_global = None;

        assert!(
            send(
                fd,
                &mut conn,
                &message(2, REQ_GET_XDG_SURFACE, &[word(40), word(10)].concat())
            )
            .is_empty()
        );
        let reserved = send(fd, &mut conn, &message(40, REQ_GET_TOPLEVEL, &word(50)));
        assert!(
            reserved
                .iter()
                .any(|m| *m == message(1, 0, &word(50)).raw())
        );

        // The window has no toplevel on the compositor, so a manager request
        // naming one cannot be forwarded: it is answered locally. The
        // decoration is created virtually, the icon is dropped.
        let mut body = word(80);
        body.extend_from_slice(&word(50));
        let decoration = send(
            fd,
            &mut conn,
            &message(70, REQ_GET_TOPLEVEL_DECORATION, &body),
        );
        assert_eq!(decoration, vec![message(1, 0, &word(80)).raw()]);
        assert_eq!(conn.pending_to_client.len(), 1, "a decoration configure");

        let mut body = word(50);
        body.extend_from_slice(&word(0));
        let icon = send(fd, &mut conn, &message(71, REQ_SET_ICON, &body));
        assert!(
            icon.is_empty(),
            "nothing may name a toplevel that is not there"
        );
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn a_converted_window_closes_in_either_order() {
        let fd = 94_023;
        let (_guard, mut conn) = reserved(fd);
        conn.ifaces.insert(2, Iface::XdgWmBase);
        conn.surface_roles.insert(10, SurfaceRole::Layer(options()));

        assert!(
            send(
                fd,
                &mut conn,
                &message(2, REQ_GET_XDG_SURFACE, &[word(40), word(10)].concat())
            )
            .is_empty()
        );
        let converted = send(fd, &mut conn, &message(40, REQ_GET_TOPLEVEL, &word(50)));
        assert!(converted.iter().any(|m| header(m).0 == 60));

        // The xdg_surface first this time. Its own tables go, the layer surface
        // stays: the toplevel's destroy is still on its way and still has to be
        // translated.
        let out = send(fd, &mut conn, &message(40, REQ_DESTROY, &[]));
        assert!(out.is_empty());
        assert!(conn.layer_windows.contains_key(&50), "still routed");
        // The callback has not answered yet, so the id is not the client's to
        // reuse: it waits for that answer, which is what releases it.
        let reservation = conn.reservations.get(&40).expect("still reserved");
        assert!(reservation.client_done && !reservation.callback_done);

        let toplevel = send(fd, &mut conn, &message(50, REQ_DESTROY, &[]));
        assert_eq!(header(&toplevel[0]), (50, REQ_LAYER_DESTROY, 8));
        assert!(!conn.layer_windows.contains_key(&50));
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn a_cached_layer_role_is_kept_when_it_cannot_be_rebuilt() {
        let fd = 94_021;
        let (_guard, mut conn) = reserved(fd);
        conn.ifaces.insert(2, Iface::XdgWmBase);
        conn.surface_roles.insert(10, SurfaceRole::Layer(options()));
        // The compositor withdrew layer shell after the previous show.
        conn.layer_shell_global = None;

        let create = message(2, REQ_GET_XDG_SURFACE, &[word(40), word(10)].concat());
        assert!(send(fd, &mut conn, &create).is_empty());
        let out = send(fd, &mut conn, &message(40, REQ_GET_TOPLEVEL, &word(50)));

        // A surface that has been a layer surface can never take another role,
        // so nothing about the block reaches the compositor — but every id the
        // client allocated is reserved, because a dropped `new_id` is a hole
        // the client's next allocation falls into.
        assert_eq!(
            out,
            vec![
                message(1, 0, &word(40)).raw(),
                message(1, 0, &word(50)).raw()
            ]
        );
        assert!(conn.reservations.contains_key(&40) && conn.reservations.contains_key(&50));
        assert!(
            matches!(conn.surface_roles.get(&10), Some(SurfaceRole::Layer(_))),
            "the decision is kept for a later show"
        );
        assert_eq!(
            conn.ifaces.get(&50),
            Some(&Iface::XdgToplevel),
            "the client still believes it has a toplevel"
        );
        assert!(
            !conn.layer_windows.contains_key(&50),
            "but none was created"
        );
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn an_interrupted_block_leaves_a_layer_surface_alone() {
        let fd = 94_022;
        let (_guard, mut conn) = reserved(fd);
        conn.ifaces.insert(2, Iface::XdgWmBase);
        conn.surface_roles.insert(10, SurfaceRole::Layer(options()));

        let create = message(2, REQ_GET_XDG_SURFACE, &[word(40), word(10)].concat());
        assert!(send(fd, &mut conn, &create).is_empty());
        let sync = message(1, 0, &word(70));
        let out = send(fd, &mut conn, &sync);

        // The creation is not forwarded: the compositor must not claim a role
        // this surface can never take back. The id is reserved instead, and the
        // cached decision survives for the next show.
        assert_eq!(out, vec![message(1, 0, &word(40)).raw(), sync.raw()]);
        assert!(conn.reservations.contains_key(&40));
        assert!(matches!(
            conn.surface_roles.get(&10),
            Some(SurfaceRole::Layer(_))
        ));
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn a_released_creation_leaves_the_surface_an_ordinary_toplevel() {
        let fd = 94_020;
        let (_guard, mut conn) = reserved(fd);
        conn.ifaces.insert(2, Iface::XdgWmBase);
        conn.surface_ids.insert(10, "released-window".into());
        assert!(state::set_layer_policy("released-window", options()));

        // The block is interrupted before the toplevel, so the creation has to
        // be released — which means the compositor claims the surface's role
        // here, on the implementations that do it in `get_xdg_surface`.
        let create = message(2, REQ_GET_XDG_SURFACE, &[word(40), word(10)].concat());
        assert!(send(fd, &mut conn, &create).is_empty());
        let sync = message(1, 0, &word(70));
        let released = send(fd, &mut conn, &sync);
        assert_eq!(released[0], create.raw());
        assert!(matches!(
            conn.surface_roles.get(&10),
            Some(SurfaceRole::Toplevel { reported: false })
        ));

        // The decision at the title must not try to convert it: asking for the
        // layer role now is the fatal error this whole hold exists to avoid.
        let (out, fx) =
            dispatch_and_collect(fd, &mut conn, &message(40, REQ_GET_TOPLEVEL, &word(50)));
        assert!(
            out.iter()
                .all(|m| !(header(m).0 == 60 && header(m).1 == REQ_GET_LAYER_SURFACE)),
            "no layer surface was asked for"
        );
        assert_eq!(conn.ifaces.get(&50), Some(&Iface::XdgToplevel));
        assert_eq!(fx.layer_shell_refused.as_deref(), Some("released-window"));

        state::clear_all_layer_policies();
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn a_held_creation_is_released_before_an_ordinary_toplevel() {
        let fd = 94_017;
        let (_guard, mut conn) = reserved(fd);
        conn.ifaces.insert(2, Iface::XdgWmBase);

        let create = message(2, REQ_GET_XDG_SURFACE, &[word(40), word(10)].concat());
        assert!(send(fd, &mut conn, &create).is_empty());

        // No title: the commit decides an ordinary toplevel, which needs the
        // client's xdg_surface to exist on the compositor.
        let role = message(40, REQ_GET_TOPLEVEL, &word(50));
        assert!(send(fd, &mut conn, &role).is_empty());
        let commit = message(10, REQ_COMMIT, &[]);
        let out = send(fd, &mut conn, &commit);

        assert_eq!(out[0], create.raw(), "the xdg_surface is created first");
        assert_eq!(out[1], role.raw());
        assert_eq!(out[2], commit.raw());
        assert_eq!(conn.ifaces.get(&50), Some(&Iface::XdgToplevel));
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn a_held_creation_is_released_when_something_else_follows() {
        let fd = 94_018;
        let (_guard, mut conn) = reserved(fd);
        conn.ifaces.insert(2, Iface::XdgWmBase);

        let create = message(2, REQ_GET_XDG_SURFACE, &[word(40), word(10)].concat());
        assert!(send(fd, &mut conn, &create).is_empty());

        // Not the toplevel the hold expects. The creation is released rather
        // than left dangling, so whatever comes next still names an object the
        // compositor has.
        let attach = message(10, 1, &[word(0), word(0), word(0)].concat());
        let out = send(fd, &mut conn, &attach);
        assert_eq!(out[0], create.raw());
        assert_eq!(out[1], attach.raw());
        assert!(conn.pending_xdg_surface.is_none());
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn a_later_role_object_reapplies_a_cached_layer_role_without_a_title() {
        let fd = 94_010;
        let (_guard, mut conn) = reserved(fd);

        // The first role was converted, caching the role on the surface.
        let first = conversion::convert_to_layer_surface(&mut conn, 40, 10, 50, options())
            .expect("converted");
        assert_eq!(first.len(), 7);

        // The client builds a new role object over the same wl_surface, with a
        // fresh toplevel id and no title.
        conn.ifaces.insert(41, Iface::XdgSurface);
        conn.xdg_to_wl.insert(41, 10);
        let out = send(fd, &mut conn, &message(41, REQ_GET_TOPLEVEL, &word(51)));

        // No bind and no title: the cached role is applied immediately, under
        // the new toplevel id.
        assert_eq!(out.len(), 6);
        assert_eq!(header(&out[0]).0, 60, "the already-bound shell object");
        assert_eq!(header(&out[0]).1, REQ_GET_LAYER_SURFACE);
        assert_eq!(u32_at(&out[0], 8), 51, "the new toplevel id");
        assert_eq!(conn.ifaces.get(&51), Some(&Iface::ZwlrLayerSurface));
        assert_eq!(conn.ifaces.get(&41), Some(&Iface::XdgSurface));
        assert_eq!(conn.wl_to_layer.get(&10), Some(&51));
        assert_eq!(conn.layer_windows.get(&51).map(|w| w.wl_surface), Some(10));
        assert!(matches!(
            conn.surface_roles.get(&10),
            Some(SurfaceRole::Layer(cached)) if *cached == options()
        ));
        assert!(conn.pending_role.is_none());
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn a_transaction_is_decided_after_the_sweep_limit() {
        let fd = 94_011;
        let (_guard, mut conn) = reserved(fd);
        let role = message(40, REQ_GET_TOPLEVEL, &word(50));
        assert!(send(fd, &mut conn, &role).is_empty());

        // The limit counts the requests swept for the role; the deciding one is
        // flushed together with them.
        for _ in 0..MAX_SWEPT_ROLE_REQUESTS - 1 {
            assert!(send(fd, &mut conn, &message(50, 9, &word(1))).is_empty());
        }
        assert!(conn.pending_role.is_some());

        let out = send(fd, &mut conn, &message(50, 9, &word(1)));
        assert_eq!(out.len(), MAX_SWEPT_ROLE_REQUESTS + 1);
        assert_eq!(out[0], role.raw(), "the role is emitted first");
        assert!(conn.pending_role.is_none());
        assert_eq!(conn.ifaces.get(&50), Some(&Iface::XdgToplevel));
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn a_surface_that_is_already_a_toplevel_refuses_the_layer_role_and_reports_it_once() {
        let fd = 94_012;
        let (_guard, mut conn) = reserved(fd);
        conn.surface_roles
            .insert(10, SurfaceRole::Toplevel { reported: false });
        conn.surface_ids.insert(10, "4711".into());
        assert!(state::set_layer_policy("4711", options()));

        // The name lives on the surface itself, which is what the refusal
        // report resolves; there is no separate application-level lookup to be
        // cleared any more.
        assert_eq!(conn.surface_ids.get(&10).map(String::as_str), Some("4711"));

        let (out, fx) =
            dispatch_and_collect(fd, &mut conn, &message(40, REQ_GET_TOPLEVEL, &word(50)));
        assert_eq!(out.len(), 1, "the surface is left an ordinary toplevel");
        assert_eq!(conn.ifaces.get(&50), Some(&Iface::XdgToplevel));
        assert_eq!(conn.ifaces.get(&40), Some(&Iface::XdgSurface));
        assert!(matches!(
            conn.surface_roles.get(&10),
            Some(SurfaceRole::Toplevel { reported: true })
        ));
        assert!(!conn.layer_windows.contains_key(&50));
        assert_eq!(fx.layer_shell_refused.as_deref(), Some("4711"));

        // A later role object on the same surface is refused again, but the
        // application is told only once.
        conn.xdg_to_wl.insert(41, 10);
        let (again, fx) =
            dispatch_and_collect(fd, &mut conn, &message(41, REQ_GET_TOPLEVEL, &word(51)));
        // The policy has been consulted; drop it before asserting so the
        // process-global map is empty again as soon as possible.
        state::clear_all_layer_policies();
        assert_eq!(again.len(), 1);
        assert_eq!(conn.ifaces.get(&51), Some(&Iface::XdgToplevel));
        assert!(!conn.layer_windows.contains_key(&51));
        assert!(
            fx.layer_shell_refused.is_none(),
            "reported once per surface"
        );
        state::clear_runtime_state_for_fd(fd);
    }
}
