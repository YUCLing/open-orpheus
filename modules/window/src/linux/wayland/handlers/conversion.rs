//! Role conversion: the only code that emits the `zwlr_layer_*` role.
//!
//! This module tracks the `zwlr_layer_shell_v1` global the compositor
//! advertises, and turns a decided role into a bound shell object plus the
//! layer-surface state requests. The client's `xdg_toplevel` id is reused as
//! the layer surface id, so both sides keep the names they allocated.
//!
//! The role outlives the role object: the compositor keeps a surface's role
//! after the client destroys its toplevel, so a surface that has taken the
//! layer role is converted again whenever the client builds a new role object
//! on it — which is what hiding and showing a window does. `roles` owns the
//! decision; this module only emits it. The `shadow` module translates or
//! drops the xdg-shell traffic that follows; nothing there binds a global or
//! decides a role.

use super::super::codec::{Iface, WlMessage};
use super::super::layer_shell;
use super::super::state::{LayerGeometry, LayerWindow, OutputInfo, SurfaceRole, WaylandConn};
use super::{Action, Effects};

/// Track the interfaces the compositor advertises.
pub(crate) fn on_registry_global(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    if let Some(name) = msg.u32_arg(8)
        && let Some((interface, after)) = msg.str_arg(12)
        && let Some(version) = msg.u32_arg(after)
    {
        conn.globals.insert(name, (interface.to_string(), version));
        if interface == layer_shell::INTERFACE {
            conn.layer_shell_global = Some((name, version));
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

/// Replace `xdg_surface.get_toplevel` with the layer-shell role.
///
/// The caller has already resolved which managed window this surface belongs
/// to, and what its options are; this only speaks the protocol. The client's
/// toplevel id is reused as the layer surface id, so both sides keep the names
/// they allocated.
///
/// Returns `None` when the conversion cannot be sent — no global, no spare
/// object id, no registry. The caller decides what that costs: an ordinary
/// toplevel for a fresh surface, or a dropped request for one that already
/// holds the layer role and can never take another.
pub(crate) fn convert_to_layer_surface(
    conn: &mut WaylandConn,
    xdg_surface_id: u32,
    surface_id: u32,
    toplevel_id: u32,
    options: layer_shell::LayerShellOptions,
    fx: &mut Effects,
) -> Option<Vec<Vec<u8>>> {
    let (global_name, version) = conn.layer_shell_global?;
    let registry_id = conn.registry_id?;

    let bound_now = conn.layer_shell_id.is_none();
    let shell_id = match conn.layer_shell_id {
        Some(id) => id,
        None => {
            let id = conn.alloc_injected_id()?;
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
    // An output the application named, or the compositor's own choice. A name
    // the client never bound is not an error: the window is still created, just
    // wherever the compositor puts it.
    let output_id = options
        .output
        .as_deref()
        .and_then(|wanted| {
            let resolved = super::super::state::output_for_name(conn, wanted);
            if resolved.is_none() {
                let known: Vec<String> = conn
                    .outputs
                    .values()
                    .flat_map(|output| output.names())
                    .map(str::to_string)
                    .collect();
                super::layer_note(|| {
                    format!(
                        "no output named {wanted} (known: {}); the compositor chooses",
                        known.join(", ")
                    )
                });
            }
            resolved
        })
        .unwrap_or(0);
    messages.push(layer_shell::get_layer_surface(
        shell_id,
        toplevel_id,
        surface_id,
        output_id,
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

    // What the window was asked for, against what the screen it is going on
    // is: a placement is margins from one output's corner, so this is the pair
    // that decides whether it can be seen at all.
    super::layer_note(|| {
        format!(
            "layer surface {toplevel_id} asked for {}x{} at ({}, {}), output {:?} of size {:?}",
            options.width,
            options.height,
            options.margin_left,
            options.margin_top,
            options.output,
            (output_id != 0)
                .then(|| conn.outputs.get(&output_id).and_then(OutputInfo::size))
                .flatten()
        )
    });
    conn.ifaces.insert(toplevel_id, Iface::ZwlrLayerSurface);
    conn.layer_windows.insert(
        toplevel_id,
        LayerWindow {
            wl_surface: surface_id,
            xdg_surface: xdg_surface_id,
            geometry: LayerGeometry {
                width: options.width,
                height: options.height,
                margin_left: options.margin_left,
                margin_top: options.margin_top,
            },
            // Unknown until the application reports it, which it does as soon
            // as its window is up.
            bounds: None,
            // Zero is the compositor's own choice, which only the surface's
            // `enter` events can name.
            output: (output_id != 0).then_some(output_id),
        },
    );
    conn.surface_roles
        .insert(surface_id, SurfaceRole::Layer(options));
    conn.wl_to_layer.insert(surface_id, toplevel_id);
    conn.xdg_to_layer.insert(xdg_surface_id, toplevel_id);
    // Cursor-enter capture is armed on the surface, exactly as for a toplevel.
    fx.arm_watchers_for.push(surface_id);

    Some(messages)
}

#[cfg(test)]
mod tests {
    use super::super::super::codec::{
        EVT_GLOBAL, EVT_GLOBAL_REMOVE, REQ_BIND, REQ_GET_LAYER_SURFACE, REQ_LAYER_SET_ANCHOR,
        REQ_LAYER_SET_EXCLUSIVE_ZONE, REQ_LAYER_SET_KEYBOARD_INTERACTIVITY, REQ_LAYER_SET_MARGIN,
        REQ_LAYER_SET_SIZE,
    };
    use super::super::super::layer_shell::LAYER_OVERLAY;
    use super::super::super::state::{self, SurfaceRole};
    use super::super::super::test_support::{
        Registered, connected, fixture, header, message, options, u32_at, wl_string, word,
    };
    use super::*;

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
        assert!(conn.globals.contains_key(&63));
    }

    /// Availability is read from the live connections, so a compositor that
    /// withdraws the global is no longer reported as able to take layer
    /// surfaces — the flag this used to keep could not go back to false.
    #[test]
    fn availability_follows_the_global_and_goes_away_with_it() {
        let (_guard, _conn) = fixture();

        // A connection with no globals yet: nothing is available. The fd is
        // deliberately high so it cannot collide with a real socket descriptor
        // used by another test's connection entry.
        let registered = Registered::new(93_007, WaylandConn::new());
        assert!(!state::is_layer_shell_available());

        registered.with(|conn| {
            let mut body = word(63);
            body.extend_from_slice(&wl_string("zwlr_layer_shell_v1"));
            body.extend_from_slice(&word(5));
            on_registry_global(conn, &message(5, EVT_GLOBAL, &body));
        });
        assert!(state::is_layer_shell_available());

        registered.with(|conn| {
            on_registry_global_remove(conn, &message(5, EVT_GLOBAL_REMOVE, &word(63)));
        });
        assert!(
            !state::is_layer_shell_available(),
            "a withdrawn global is not available"
        );
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
    fn a_conversion_emits_the_layer_role_and_caches_it_for_the_surface() {
        let (_guard, mut conn) = fixture();
        let mut fx = Effects::default();

        let messages = convert_to_layer_surface(&mut conn, 20, 10, 30, options(), &mut fx)
            .expect("the conversion is sendable");

        // bind, get_layer_surface, then the five state requests.
        assert_eq!(messages.len(), 7);
        assert_eq!(header(&messages[0]).0, 5, "bound on the client's registry");
        assert_eq!(header(&messages[0]).1, REQ_BIND);
        assert_eq!(header(&messages[1]).0, 50, "the stolen shell id");
        assert_eq!(header(&messages[1]).1, REQ_GET_LAYER_SURFACE);
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

        // get_layer_surface carries the surface, a null output and the namespace.
        assert_eq!(u32_at(&messages[1], 8), 30);
        assert_eq!(u32_at(&messages[1], 12), 10);
        assert_eq!(u32_at(&messages[1], 16), 0, "null output");
        assert_eq!(u32_at(&messages[1], 20), LAYER_OVERLAY);

        assert_eq!(conn.ifaces.get(&30), Some(&Iface::ZwlrLayerSurface));
        assert_eq!(conn.ifaces.get(&50), Some(&Iface::ZwlrLayerShell));
        assert_eq!(conn.layer_shell_id, Some(50));
        assert_eq!(conn.wl_to_layer.get(&10), Some(&30));
        assert_eq!(conn.xdg_to_layer.get(&20), Some(&30));
        assert_eq!(conn.layer_windows.get(&30).map(|w| w.wl_surface), Some(10));
        assert_eq!(conn.layer_windows.get(&30).map(|w| w.xdg_surface), Some(20));
        // The role is cached on the surface so a later role object re-applies it.
        assert!(matches!(
            conn.surface_roles.get(&10),
            Some(SurfaceRole::Layer(cached)) if *cached == options()
        ));
        assert_eq!(fx.arm_watchers_for, vec![10]);
    }

    #[test]
    fn a_second_conversion_reuses_the_bound_shell_object() {
        let (_guard, mut conn) = fixture();
        let mut fx = Effects::default();

        let first =
            convert_to_layer_surface(&mut conn, 20, 10, 30, options(), &mut fx).expect("bound");
        assert_eq!(header(&first[0]).1, REQ_BIND);

        conn.ifaces.insert(11, Iface::WlSurface);
        conn.ifaces.insert(21, Iface::XdgSurface);
        conn.xdg_to_wl.insert(21, 11);
        let second =
            convert_to_layer_surface(&mut conn, 21, 11, 31, options(), &mut fx).expect("converted");

        // No second bind: the shell object the proxy bound is reused.
        assert_eq!(second.len(), 6);
        assert_eq!(header(&second[0]).0, 50, "the bound shell object");
        assert_eq!(header(&second[0]).1, REQ_GET_LAYER_SURFACE);
    }

    #[test]
    fn conversion_needs_a_global_a_registry_and_a_spare_id() {
        let (_guard, _conn) = fixture();
        let mut fx = Effects::default();

        let mut conn = connected();
        conn.layer_shell_global = None;
        assert!(convert_to_layer_surface(&mut conn, 20, 10, 30, options(), &mut fx).is_none());
        assert!(conn.layer_windows.is_empty());

        let mut conn = connected();
        conn.registry_id = None;
        assert!(convert_to_layer_surface(&mut conn, 20, 10, 30, options(), &mut fx).is_none());

        let mut conn = connected();
        conn.stolen_ids.clear();
        assert!(convert_to_layer_surface(&mut conn, 20, 10, 30, options(), &mut fx).is_none());

        // Nothing was half-applied, so the surface is still undecided.
        assert!(conn.surface_roles.is_empty());
        assert!(conn.layer_windows.is_empty());
    }

    #[test]
    fn destroying_the_surface_forgets_its_layer_role() {
        let (_guard, mut conn) = fixture();
        convert_to_layer_surface(&mut conn, 20, 10, 30, options(), &mut Effects::default())
            .expect("the conversion is sendable");
        assert!(matches!(
            conn.surface_roles.get(&10),
            Some(SurfaceRole::Layer(_))
        ));

        conn.purge(10);

        assert!(conn.surface_roles.is_empty(), "a new surface starts clean");
        assert!(conn.layer_windows.is_empty());
    }
}
