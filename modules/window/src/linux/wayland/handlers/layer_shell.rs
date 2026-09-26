//! Layer-shell functionality: registry tracking, the positional declaration
//! that picks a window, and the xdg-shell ⇄ layer-shell translation.
//!
//! The compositor sees a layer surface where the client believes it has an
//! `xdg_toplevel`. The client's toplevel id is reused as the layer surface id,
//! so both sides keep using the names they allocated.
//!
//! The role outlives the role object: the compositor keeps a surface's role
//! after the client destroys its toplevel, so a surface that has taken the
//! layer role is converted again whenever the client builds a new role object
//! on it — which is what hiding and showing a window does.

use std::os::fd::RawFd;

use super::super::codec::{
    DECORATION_CLIENT_SIDE, EVT_LAYER_CLOSED, EVT_LAYER_CONFIGURE, Iface, REQ_ACK_CONFIGURE,
    REQ_DECORATION_DESTROY, REQ_DESTROY, REQ_GET_POPUP, REQ_GET_TOPLEVEL, REQ_SET_TITLE,
    REQ_SET_WINDOW_GEOMETRY, WlMessage,
};
use super::super::layer_shell;
use super::super::state::{self, LayerWindow, WaylandConn};
use super::{Action, Effects, objects};

/// Track the interfaces the compositor advertises.
pub(crate) fn on_registry_global(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    if let Some(name) = msg.u32_arg(8)
        && let Some((interface, after)) = msg.str_arg(12)
        && let Some(version) = msg.u32_arg(after)
    {
        conn.globals.insert(name, (interface.to_string(), version));
        if interface == layer_shell::INTERFACE {
            conn.layer_shell_global = Some((name, version));
            state::mark_layer_shell_available();
        }
    }
    Action::Forward
}

/// Forget a global the compositor withdrew.
pub(crate) fn on_registry_global_remove(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    if let Some(name) = msg.u32_arg(8) {
        conn.globals.remove(&name);
        if conn
            .layer_shell_global
            .is_some_and(|(global, _)| global == name)
        {
            conn.layer_shell_global = None;
        }
    }
    Action::Forward
}

/// Consume a declaration and, when it applies, replace `get_toplevel`.
///
/// This is the only place a window takes on the layer-shell role: the
/// declaration is positional, so the next toplevel the client creates is the
/// one it describes. Any missing precondition leaves the window an ordinary
/// toplevel rather than risking a protocol error.
///
/// A surface that already holds the role is converted again with the
/// declaration that put it there, because the compositor will not hand the
/// surface a different role while it lives — the client destroys and re-creates
/// its `xdg_toplevel` whenever it hides and shows the window.
pub(crate) fn on_get_toplevel(
    _fd: RawFd,
    conn: &mut WaylandConn,
    msg: &WlMessage,
    fx: &mut Effects,
) -> Action {
    let declaration = state::take_layer_window_declaration();
    let xdg_surface_id = msg.object_id;
    let surface_id = conn.xdg_to_wl.get(&xdg_surface_id).copied();
    let previously = surface_id.is_some_and(|id| conn.layer_surfaces.contains_key(&id));
    let options =
        declaration.or_else(|| surface_id.and_then(|id| conn.layer_surfaces.get(&id).cloned()));

    let Some(options) = options else {
        return objects::on_get_toplevel(conn, msg, fx);
    };

    let Some(toplevel_id) = msg.u32_arg(8) else {
        return fall_back(conn, msg, fx, previously, "the request has no new id");
    };
    let Some(surface_id) = surface_id else {
        return fall_back(
            conn,
            msg,
            fx,
            previously,
            "the xdg_surface is not a known surface",
        );
    };
    let Some((global_name, version)) = conn.layer_shell_global else {
        return fall_back(
            conn,
            msg,
            fx,
            previously,
            "the compositor has no layer shell",
        );
    };
    let Some(registry_id) = conn.registry_id else {
        return fall_back(conn, msg, fx, previously, "the client has no wl_registry");
    };

    let bound_now = conn.layer_shell_id.is_none();
    let shell_id = match conn.layer_shell_id {
        Some(id) => id,
        None => {
            let Some(id) = conn.alloc_injected_id() else {
                return fall_back(conn, msg, fx, previously, "no spare object id to bind with");
            };
            conn.layer_shell_id = Some(id);
            conn.ifaces.insert(id, Iface::ZwlrLayerShell);
            id
        }
    };

    let mut messages = Vec::with_capacity(7);
    // Bind the version this proxy understands, not the server's maximum.
    let bound_version = version.min(layer_shell::SUPPORTED_VERSION);
    if bound_now {
        messages.push(layer_shell::bind(
            registry_id,
            global_name,
            bound_version,
            shell_id,
        ));
    }
    messages.push(layer_shell::get_layer_surface(
        shell_id,
        toplevel_id,
        surface_id,
        options.layer,
        &options.namespace,
    ));
    messages.push(layer_shell::set_size(
        toplevel_id,
        options.width,
        options.height,
    ));
    messages.push(layer_shell::set_anchor(toplevel_id, options.anchor));
    messages.push(layer_shell::set_exclusive_zone(
        toplevel_id,
        options.exclusive_zone,
    ));
    messages.push(layer_shell::set_margin(
        toplevel_id,
        [
            options.margin_top,
            options.margin_right,
            options.margin_bottom,
            options.margin_left,
        ],
    ));
    messages.push(layer_shell::set_keyboard_interactivity(
        toplevel_id,
        options.effective_keyboard(bound_version),
    ));

    conn.ifaces.insert(toplevel_id, Iface::ZwlrLayerSurface);
    conn.layer_windows.insert(
        toplevel_id,
        LayerWindow {
            wl_surface: surface_id,
            xdg_surface: xdg_surface_id,
        },
    );
    conn.layer_surfaces.insert(surface_id, options);
    conn.wl_to_layer.insert(surface_id, toplevel_id);
    conn.xdg_to_layer.insert(xdg_surface_id, toplevel_id);
    // Cursor-enter capture is armed on the surface, exactly as for a toplevel.
    fx.arm_watchers_for = Some(surface_id);

    Action::Replace(messages)
}

/// Wire the window up as a normal toplevel after a declaration could not be
/// honoured, so the failure costs the role and not the window.
///
/// That is only an option for a fresh surface. One that already holds the layer
/// role cannot be given an xdg-shell role at all, so the request is dropped
/// instead: the window never maps, but the connection lives.
fn fall_back(
    conn: &mut WaylandConn,
    msg: &WlMessage,
    fx: &mut Effects,
    previously_converted: bool,
    reason: &str,
) -> Action {
    eprintln!("[proxy:wayland] layer-shell declaration dropped: {reason}");
    if previously_converted {
        return Action::Suppress;
    }
    objects::on_get_toplevel(conn, msg, fx)
}

/// Requests from a client that still believes its window is an `xdg_toplevel`.
///
/// Every one of them is dropped: the compositor only knows the object as a
/// layer surface, so forwarding any xdg-toplevel opcode would be misread as a
/// different layer request (or rejected outright).
pub(crate) fn on_client_toplevel_request(
    fd: RawFd,
    conn: &mut WaylandConn,
    msg: &WlMessage,
) -> Action {
    match msg.opcode {
        REQ_DESTROY => {
            conn.purge(msg.object_id);
            Action::Replace(vec![layer_shell::destroy(msg.object_id)])
        }
        REQ_SET_TITLE => {
            // The smuggled window id still has to be captured, but a title has
            // no meaning for a layer surface.
            let _ = super::title::on_set_title(fd, conn, msg);
            Action::Suppress
        }
        _ => Action::Suppress,
    }
}

/// Requests from a client on the `xdg_surface` of a converted window.
///
/// Its compositor-side counterpart was created but never given a role, so
/// anything that would touch it has to be dropped or translated.
pub(crate) fn on_client_xdg_surface_request(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    match msg.opcode {
        REQ_DESTROY => {
            conn.purge(msg.object_id);
            Action::Forward
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
    if !conn.layer_windows.contains_key(&toplevel_id) {
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
        Some(toplevel_id) if conn.layer_windows.contains_key(&toplevel_id) => Action::Suppress,
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
    use std::sync::{Mutex, MutexGuard};

    use super::super::super::codec::{
        DECORATION_CLIENT_SIDE, EVT_DECORATION_CONFIGURE, EVT_GLOBAL, EVT_LAYER_CLOSED,
        EVT_LAYER_CONFIGURE, EVT_TOPLEVEL_CLOSE, EVT_TOPLEVEL_CONFIGURE, REQ_ACK_CONFIGURE,
        REQ_BIND, REQ_DECORATION_DESTROY, REQ_DESTROY, REQ_GET_POPUP, REQ_GET_TOPLEVEL_DECORATION,
        REQ_LAYER_ACK_CONFIGURE, REQ_LAYER_DESTROY, REQ_LAYER_GET_POPUP, REQ_LAYER_SET_ANCHOR,
        REQ_LAYER_SET_EXCLUSIVE_ZONE, REQ_LAYER_SET_KEYBOARD_INTERACTIVITY, REQ_LAYER_SET_MARGIN,
        REQ_LAYER_SET_SIZE, REQ_SET_ICON, REQ_SET_TITLE, REQ_SET_WINDOW_GEOMETRY,
    };
    use super::super::super::layer_shell::{
        ANCHOR_ALL, ANCHOR_BOTTOM, ANCHOR_LEFT, ANCHOR_RIGHT, ANCHOR_TOP, LAYER_OVERLAY,
        LayerShellOptions,
    };
    use super::super::super::state::{self, CUSTOM_ID_MAP};
    use super::super::super::test_support::{message, wl_string, word};
    use super::*;

    /// The declaration queue and availability flag are process-global, so the
    /// tests that touch them run one at a time.
    static SERIAL: Mutex<()> = Mutex::new(());

    fn header(buf: &[u8]) -> (u32, u16, usize) {
        let packed = u32::from_ne_bytes(buf[4..8].try_into().unwrap());
        (
            u32::from_ne_bytes(buf[0..4].try_into().unwrap()),
            (packed & 0xFFFF) as u16,
            (packed >> 16) as usize,
        )
    }

    fn u32_at(buf: &[u8], offset: usize) -> u32 {
        u32::from_ne_bytes(buf[offset..offset + 4].try_into().unwrap())
    }

    fn replaced(action: Action) -> Vec<Vec<u8>> {
        match action {
            Action::Replace(messages) => messages,
            _ => panic!("expected a replacement"),
        }
    }

    fn options() -> LayerShellOptions {
        LayerShellOptions {
            namespace: "open-orpheus-test".into(),
            layer: LAYER_OVERLAY,
            anchor: ANCHOR_TOP | ANCHOR_BOTTOM | ANCHOR_LEFT | ANCHOR_RIGHT,
            ..Default::default()
        }
    }

    /// A connection that has seen a compositor, an xdg_surface and one spare id.
    fn connected() -> WaylandConn {
        let mut conn = WaylandConn::new();
        conn.registry_id = Some(5);
        conn.ifaces.insert(5, Iface::WlRegistry);
        conn.layer_shell_global = Some((63, 5));
        conn.ifaces.insert(10, Iface::WlSurface);
        conn.ifaces.insert(20, Iface::XdgSurface);
        conn.xdg_to_wl.insert(20, 10);
        conn.stolen_ids.push(50);
        conn
    }

    fn fixture() -> (MutexGuard<'static, ()>, WaylandConn) {
        let guard = SERIAL
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state::init_state();
        // Drain the declaration queue without touching the global connection
        // state other tests are using.
        while state::take_layer_window_declaration().is_some() {}
        (guard, connected())
    }

    /// Convert the pending window the way the dispatcher would.
    fn convert(conn: &mut WaylandConn) {
        assert!(state::declare_layer_window(options()));
        let mut fx = Effects::default();
        let action = on_get_toplevel(
            7,
            conn,
            &message(20, super::super::super::codec::REQ_GET_TOPLEVEL, &word(30)),
            &mut fx,
        );
        assert!(matches!(action, Action::Replace(_)));
    }

    #[test]
    fn registry_globals_are_tracked_and_layer_shell_noticed() {
        let (_guard, mut conn) = fixture();

        let mut body = word(63);
        body.extend_from_slice(&wl_string("zwlr_layer_shell_v1"));
        body.extend_from_slice(&word(5));
        let action = on_registry_global(&mut conn, &message(5, EVT_GLOBAL, &body));

        assert!(matches!(action, Action::Forward));
        assert_eq!(
            conn.globals.get(&63).map(|(name, _)| name.as_str()),
            Some("zwlr_layer_shell_v1")
        );
        assert_eq!(conn.layer_shell_global, Some((63, 5)));
        assert!(state::is_layer_shell_available());
    }

    #[test]
    fn a_global_that_is_not_layer_shell_is_only_recorded() {
        let (_guard, mut conn) = fixture();

        let mut body = word(64);
        body.extend_from_slice(&wl_string("wl_shm"));
        body.extend_from_slice(&word(1));
        on_registry_global(&mut conn, &message(5, EVT_GLOBAL, &body));

        assert_eq!(
            conn.globals.get(&64).map(|(name, _)| name.as_str()),
            Some("wl_shm")
        );
        assert_eq!(conn.layer_shell_global, Some((63, 5)), "unchanged");
    }

    #[test]
    fn a_declaration_converts_the_next_toplevel() {
        let (_guard, mut conn) = fixture();
        assert!(state::declare_layer_window(options()));

        let mut fx = Effects::default();
        let action = on_get_toplevel(
            7,
            &mut conn,
            &message(20, super::super::super::codec::REQ_GET_TOPLEVEL, &word(30)),
            &mut fx,
        );
        let messages = replaced(action);

        // bind, get_layer_surface, then the five state requests.
        assert_eq!(messages.len(), 7);
        assert_eq!(header(&messages[0]).0, 5, "bound on the client's registry");
        assert_eq!(header(&messages[0]).1, REQ_BIND);
        assert_eq!(header(&messages[1]).0, 50, "the stolen shell id");
        assert_eq!(
            header(&messages[1]).1,
            super::super::super::codec::REQ_GET_LAYER_SURFACE
        );
        assert_eq!(
            header(&messages[2]),
            (30, REQ_LAYER_SET_SIZE, 16),
            "state is applied to the toplevel id"
        );
        assert_eq!(header(&messages[3]), (30, REQ_LAYER_SET_ANCHOR, 12));
        assert_eq!(header(&messages[4]), (30, REQ_LAYER_SET_EXCLUSIVE_ZONE, 12));
        assert_eq!(header(&messages[5]), (30, REQ_LAYER_SET_MARGIN, 24));
        assert_eq!(
            header(&messages[6]),
            (30, REQ_LAYER_SET_KEYBOARD_INTERACTIVITY, 12)
        );

        // get_layer_surface carries the surface and the namespace.
        assert_eq!(u32_at(&messages[1], 8), 30);
        assert_eq!(u32_at(&messages[1], 12), 10);
        assert_eq!(u32_at(&messages[1], 16), 0, "null output");
        assert_eq!(u32_at(&messages[1], 20), LAYER_OVERLAY);

        assert_eq!(conn.ifaces.get(&30), Some(&Iface::ZwlrLayerSurface));
        assert_eq!(conn.ifaces.get(&50), Some(&Iface::ZwlrLayerShell));
        assert_eq!(conn.layer_shell_id, Some(50));
        assert_eq!(conn.wl_to_layer.get(&10), Some(&30));
        assert_eq!(conn.xdg_to_layer.get(&20), Some(&30));
        assert!(conn.layer_windows.contains_key(&30));
        assert_eq!(fx.arm_watchers_for, Some(10));
    }

    #[test]
    fn without_a_declaration_the_toplevel_is_untouched() {
        let (_guard, mut conn) = fixture();

        let mut fx = Effects::default();
        let action = on_get_toplevel(
            7,
            &mut conn,
            &message(20, super::super::super::codec::REQ_GET_TOPLEVEL, &word(30)),
            &mut fx,
        );

        assert!(matches!(action, Action::Forward));
        assert_eq!(conn.ifaces.get(&30), Some(&Iface::XdgToplevel));
        assert_eq!(conn.wl_to_top.get(&10), Some(&30));
        assert!(conn.layer_windows.is_empty());
    }

    #[test]
    fn a_declaration_without_a_layer_shell_falls_back_to_a_toplevel() {
        let (_guard, mut conn) = fixture();
        conn.layer_shell_global = None;
        assert!(state::declare_layer_window(options()));

        let mut fx = Effects::default();
        let action = on_get_toplevel(
            7,
            &mut conn,
            &message(20, super::super::super::codec::REQ_GET_TOPLEVEL, &word(30)),
            &mut fx,
        );

        assert!(matches!(action, Action::Forward), "the window still opens");
        assert_eq!(conn.ifaces.get(&30), Some(&Iface::XdgToplevel));
        assert!(conn.layer_windows.is_empty());
        // The declaration was consumed, so it cannot leak onto another window.
        assert!(state::take_layer_window_declaration().is_none());
    }

    #[test]
    fn client_toplevel_requests_are_never_forwarded() {
        let (_guard, mut conn) = fixture();
        convert(&mut conn);

        // A title is captured and swallowed rather than reaching a surface
        // that has no title.
        let title = format!(
            "{}{}",
            super::super::super::codec::CUSTOM_ID_PREFIX,
            "layer-window-99"
        );
        let action = on_client_toplevel_request(
            7,
            &mut conn,
            &message(30, REQ_SET_TITLE, &wl_string(&title)),
        );
        assert!(matches!(action, Action::Suppress));
        let map = CUSTOM_ID_MAP.get().unwrap().lock().unwrap();
        assert_eq!(
            map.get("layer-window-99"),
            Some(&(7, 10)),
            "id resolved to the surface"
        );
        drop(map);
        if let Some(m) = CUSTOM_ID_MAP.get()
            && let Ok(mut map) = m.lock()
        {
            map.remove("layer-window-99");
        }

        // Anything else is dropped too: the compositor only knows a layer
        // surface under this id.
        let action = on_client_toplevel_request(
            7,
            &mut conn,
            &message(30, super::super::super::codec::REQ_MOVE, &word(1)),
        );
        assert!(matches!(action, Action::Suppress));

        // Destroying the toplevel destroys the layer surface.
        let messages = replaced(on_client_toplevel_request(
            7,
            &mut conn,
            &message(30, super::super::super::codec::REQ_DESTROY, &[]),
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
    fn declarations_are_queued_cancelled_and_validated() {
        let (_guard, _conn) = fixture();

        assert!(state::declare_layer_window(options()));
        assert!(state::cancel_layer_window());
        assert!(state::take_layer_window_declaration().is_none());

        assert!(
            !state::declare_layer_window(LayerShellOptions::default()),
            "no namespace"
        );

        assert!(state::declare_layer_window(options()));
        assert!(state::take_layer_window_declaration().is_some());
        assert!(state::take_layer_window_declaration().is_none());
    }

    #[test]
    fn a_declaration_without_size_or_anchors_covers_the_output() {
        let (_guard, _conn) = fixture();

        assert!(state::declare_layer_window(LayerShellOptions {
            namespace: "open-orpheus-layers".into(),
            ..Default::default()
        }));

        let options = state::take_layer_window_declaration().expect("queued");
        assert_eq!(options.anchor, ANCHOR_ALL);
        assert_eq!((options.width, options.height), (0, 0));
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

    /// Hiding and showing a window makes the client build a new xdg_toplevel
    /// over the same wl_surface, which the compositor still knows as a layer
    /// surface. Asking it for a toplevel there is a protocol error, so the new
    /// role object has to be converted again.
    #[test]
    fn a_converted_surface_is_converted_again_for_a_new_toplevel() {
        let (_guard, mut conn) = fixture();
        convert(&mut conn);
        assert!(conn.layer_surfaces.contains_key(&10));

        let action = on_client_toplevel_request(7, &mut conn, &message(30, REQ_DESTROY, &[]));
        assert!(
            matches!(action, Action::Replace(_)),
            "the layer surface goes"
        );

        // The client re-created its shell objects over the same surface.
        conn.ifaces.insert(40, Iface::XdgSurface);
        conn.xdg_to_wl.insert(40, 10);

        let mut fx = Effects::default();
        let action = on_get_toplevel(
            7,
            &mut conn,
            &message(40, REQ_GET_TOPLEVEL, &word(50)),
            &mut fx,
        );

        assert!(matches!(action, Action::Replace(_)), "converted again");
        assert_eq!(conn.ifaces.get(&50), Some(&Iface::ZwlrLayerSurface));
        assert_eq!(conn.layer_windows.get(&50).map(|w| w.wl_surface), Some(10));
        assert_eq!(conn.xdg_to_layer.get(&40), Some(&50));
    }

    #[test]
    fn a_surface_that_was_never_converted_stays_ordinary() {
        let (_guard, mut conn) = fixture();
        conn.ifaces.insert(40, Iface::XdgSurface);
        conn.xdg_to_wl.insert(40, 11);

        let mut fx = Effects::default();
        let action = on_get_toplevel(
            7,
            &mut conn,
            &message(40, REQ_GET_TOPLEVEL, &word(50)),
            &mut fx,
        );

        assert!(matches!(action, Action::Forward));
    }

    #[test]
    fn destroying_the_surface_forgets_its_layer_role() {
        let (_guard, mut conn) = fixture();
        convert(&mut conn);

        conn.purge(10);

        assert!(conn.layer_surfaces.is_empty(), "a new surface starts clean");
    }
}
