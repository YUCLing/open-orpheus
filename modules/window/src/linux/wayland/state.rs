use std::{
    collections::{HashMap, HashSet},
    os::fd::RawFd,
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicU32, Ordering},
    },
    time::{Duration, Instant},
};

use super::codec::Iface;
use super::layer_shell::LayerShellOptions;

const MAX_POPUP_DIMENSION: i32 = 8_192;

#[derive(Clone, Copy, Debug)]
pub(crate) struct PopupGeometry {
    pub(crate) inset: i32,
    pub(crate) width: i32,
    pub(crate) height: i32,
}

// ── Per-connection tracking state ──────────────────────────────────────────

/// A window the proxy converted into a layer surface on the compositor side.
#[derive(Clone, Debug)]
pub(crate) struct LayerWindow {
    pub(crate) wl_surface: u32,
    pub(crate) xdg_surface: u32,
}

/// What the proxy remembers about one output the compositor advertised.
///
/// The entry is keyed by the `wl_registry` global name, which is the
/// `Display.id` Electron exposes. A layer surface takes its output when the
/// compositor creates its role, so the objects the client bound for the output
/// are kept here for that decision.
#[derive(Clone, Debug, Default)]
pub(crate) struct Output {
    /// The client's `wl_output` objects for this output, in bind order.
    pub(crate) objects: Vec<u32>,
    /// The compositor's own name for it, e.g. `DP-1` (wl_output v4).
    pub(crate) name: Option<String>,
}

/// The role a `wl_surface` has taken for the rest of its life.
///
/// A compositor assigns a surface's role once and never releases it while the
/// surface lives, so this is decided at the surface's first role creation and
/// from then on it is the authority: the surface either becomes a layer
/// surface again on every later role object, or stays an ordinary toplevel
/// that can never be converted.
#[derive(Clone, Debug)]
pub(crate) enum SurfaceRole {
    /// Converted to `zwlr_layer_surface_v1`, with the options it was created
    /// with so a later role object on the same surface can be converted again.
    Layer(LayerShellOptions),
    /// An ordinary `xdg_toplevel`.
    ///
    /// `reported` records that a later layer policy was refused for this
    /// surface and the application has been told once: the policy outlives the
    /// first role object, so without it the window would be reported on every
    /// show.
    Toplevel { reported: bool },
}

/// What is left of an id the compositor reserved with a callback for a client
/// object it was not allowed to create.
///
/// Both sides finish independently — the compositor when it answers the
/// callback, the client when it destroys its object — so the id can only be
/// released once both are done, and whichever finishes second does the
/// releasing.
#[derive(Default)]
pub(crate) struct Reservation {
    /// The client has destroyed the object it created under this id.
    pub(crate) client_done: bool,
    /// The compositor has consumed the callback that reserved the id.
    pub(crate) callback_done: bool,
}

pub(crate) struct WaylandConn {
    pub(crate) ifaces: HashMap<u32, Iface>,
    pub(crate) pointer_focus: HashMap<u32, u32>,
    pub(crate) pointer_position: HashMap<u32, (i32, i32)>,
    pub(crate) pointer_seat: HashMap<u32, u32>,
    pub(crate) touch_seat: HashMap<u32, u32>,
    pub(crate) xdg_to_wl: HashMap<u32, u32>,
    pub(crate) wl_to_top: HashMap<u32, u32>,
    pub(crate) top_to_xdg: HashMap<u32, u32>,
    /// Client-side shadow margins, owned by the converted xdg_surface.
    pub(crate) popup_geometries: HashMap<u32, PopupGeometry>,
    pub(crate) compositor_id: Option<u32>,
    pub(crate) xdg_wm_base_id: Option<u32>,
    pub(crate) injected_ids: HashSet<u32>,
    pub(crate) stolen_ids: Vec<u32>,
    /// Interfaces the compositor advertised: global name → (interface, version).
    pub(crate) globals: HashMap<u32, (String, u32)>,
    /// Outputs the compositor advertised, keyed by the same global name — the
    /// `Display.id` Electron reports for the display.
    pub(crate) outputs: HashMap<u32, Output>,
    pub(crate) registry_id: Option<u32>,
    /// The `zwlr_layer_shell_v1` global as (global name, advertised version).
    pub(crate) layer_shell_global: Option<(u32, u32)>,
    /// The shell object the proxy bound for itself, once it was first needed.
    pub(crate) layer_shell_id: Option<u32>,
    /// Converted windows, keyed by the id the client uses for its toplevel.
    pub(crate) layer_windows: HashMap<u32, LayerWindow>,
    /// The role each surface has taken, decided once at its first role
    /// creation and re-applied to every later role object.
    ///
    /// The role outlives the role object: a surface that asks for a toplevel
    /// again after being converted has to be converted again, and a surface
    /// that was an ordinary toplevel can never take the layer role. It is
    /// dropped with the surface, so a genuinely new surface starts undecided.
    pub(crate) surface_roles: HashMap<u32, SurfaceRole>,
    /// The managed window id each surface belongs to, for the life of the
    /// surface.
    ///
    /// This is the application's name for the surface, and it dies with the
    /// surface itself; `state::window_surface` is the reverse lookup.
    pub(crate) surface_ids: HashMap<u32, String>,
    pub(crate) wl_to_layer: HashMap<u32, u32>,
    pub(crate) xdg_to_layer: HashMap<u32, u32>,
    /// Messages the proxy owes the client, queued by a request handler and
    /// flushed on the next inbound chunk.
    pub(crate) pending_to_client: Vec<Vec<u8>>,
    /// The role transaction currently open on this connection, if any.
    pub(crate) pending_role: Option<super::handlers::roles::PendingRole>,
    /// A `get_xdg_surface` held until the window identity decides its role.
    pub(crate) pending_xdg_surface: Option<super::handlers::roles::PendingXdgSurface>,
    /// Ids the client owns that the compositor was never allowed to create an
    /// object for, and that a callback reserved instead — a converted window's
    /// `xdg_surface`, and every id of a client block that had to be dropped.
    ///
    /// Reserving is not optional: a suppressed `new_id` leaves a hole in the
    /// compositor's object map at the edge it is still growing, and the id
    /// allocated right after it is refused outright, which takes the whole
    /// display connection down.
    ///
    /// The reservation has two lifetimes, not one. The callback is consumed by
    /// the compositor as soon as it answers, while the client may keep its
    /// object — or destroy it — for however long it likes, and either can
    /// happen first. The id is released when both are done, and the callback's
    /// events are hidden until then.
    pub(crate) reservations: HashMap<u32, Reservation>,
}

impl WaylandConn {
    pub(crate) fn new() -> Self {
        let mut ifaces = HashMap::new();
        ifaces.insert(1u32, Iface::WlDisplay);
        Self {
            ifaces,
            pointer_focus: HashMap::new(),
            pointer_position: HashMap::new(),
            pointer_seat: HashMap::new(),
            touch_seat: HashMap::new(),
            xdg_to_wl: HashMap::new(),
            wl_to_top: HashMap::new(),
            top_to_xdg: HashMap::new(),
            popup_geometries: HashMap::new(),
            compositor_id: None,
            xdg_wm_base_id: None,
            injected_ids: HashSet::new(),
            stolen_ids: Vec::new(),
            globals: HashMap::new(),
            outputs: HashMap::new(),
            registry_id: None,
            layer_shell_global: None,
            layer_shell_id: None,
            layer_windows: HashMap::new(),
            surface_roles: HashMap::new(),
            surface_ids: HashMap::new(),
            wl_to_layer: HashMap::new(),
            xdg_to_layer: HashMap::new(),
            pending_to_client: Vec::new(),
            pending_role: None,
            pending_xdg_surface: None,
            reservations: HashMap::new(),
        }
    }

    pub(crate) fn reset_tracking(&mut self) {
        self.ifaces.clear();
        self.ifaces.insert(1u32, Iface::WlDisplay);
        self.pointer_focus.clear();
        self.pointer_position.clear();
        self.pointer_seat.clear();
        self.touch_seat.clear();
        self.xdg_to_wl.clear();
        self.wl_to_top.clear();
        self.top_to_xdg.clear();
        self.popup_geometries.clear();
        self.compositor_id = None;
        self.xdg_wm_base_id = None;
        self.injected_ids.clear();
        self.stolen_ids.clear();
        self.globals.clear();
        self.outputs.clear();
        self.registry_id = None;
        self.layer_shell_global = None;
        // The layer shell object belongs to the client namespace, so it has to
        // be re-bound after a resync.
        self.layer_shell_id = None;
        self.layer_windows.clear();
        self.surface_roles.clear();
        self.surface_ids.clear();
        self.wl_to_layer.clear();
        self.xdg_to_layer.clear();
        self.pending_to_client.clear();
        self.pending_role = None;
        self.pending_xdg_surface = None;
        self.reservations.clear();
    }

    pub(crate) fn alloc_injected_id(&mut self) -> Option<u32> {
        let id = self.stolen_ids.pop()?;
        self.injected_ids.insert(id);
        Some(id)
    }

    pub(crate) fn purge(&mut self, id: u32) {
        // A record of an id the compositor never created dies with the id. The
        // client's destroy is the only thing left that can name it, and that is
        // what reaches here.
        self.reservations.remove(&id);
        // A held creation for the surface being destroyed has nothing left to
        // open.
        if self
            .pending_xdg_surface
            .as_ref()
            .is_some_and(|pending| pending.concerns(id))
        {
            self.pending_xdg_surface = None;
        }
        match self.ifaces.get(&id).copied() {
            Some(Iface::WlPointer) => {
                self.pointer_focus.remove(&id);
                self.pointer_position.remove(&id);
                self.pointer_seat.remove(&id);
            }
            Some(Iface::WlTouch) => {
                self.touch_seat.remove(&id);
            }
            Some(Iface::WlOutput) => {
                super::outputs::destroyed(self, id);
            }
            Some(Iface::WlSurface) => {
                if let Some(layer_id) = self.wl_to_layer.remove(&id) {
                    self.purge(layer_id);
                }
                // The role dies with the surface it was assigned to.
                self.surface_roles.remove(&id);
                self.surface_ids.remove(&id);
                self.popup_geometries
                    .retain(|xdg, _| self.xdg_to_wl.get(xdg) != Some(&id));
                self.xdg_to_wl.retain(|_, v| *v != id);
                self.wl_to_top.remove(&id);
                let focused_pointers: Vec<u32> = self
                    .pointer_focus
                    .iter()
                    .filter_map(|(pointer, surface)| (*surface == id).then_some(*pointer))
                    .collect();
                for pointer in focused_pointers {
                    self.pointer_focus.remove(&pointer);
                    self.pointer_position.remove(&pointer);
                }
            }
            Some(Iface::XdgSurface) => {
                self.popup_geometries.remove(&id);
                if let Some(layer_id) = self.xdg_to_layer.remove(&id) {
                    self.purge(layer_id);
                }
                let owned_top = self
                    .top_to_xdg
                    .iter()
                    .find(|(_, v)| **v == id)
                    .map(|(k, _)| *k);
                if let Some(tid) = owned_top {
                    self.purge(tid);
                }
                self.xdg_to_wl.remove(&id);
            }
            Some(Iface::XdgToplevel | Iface::XdgPopupShim) => {
                if let Some(xdg) = self.top_to_xdg.get(&id) {
                    self.popup_geometries.remove(xdg);
                }
                self.top_to_xdg.remove(&id);
                self.wl_to_top.retain(|_, v| *v != id);
            }
            Some(Iface::ZwlrLayerShell) => {
                if self.layer_shell_id == Some(id) {
                    self.layer_shell_id = None;
                }
            }
            Some(Iface::ZwlrLayerSurface) => {
                if let Some(window) = self.layer_windows.remove(&id) {
                    self.wl_to_layer.remove(&window.wl_surface);
                    self.xdg_to_layer.remove(&window.xdg_surface);
                }
            }
            Some(Iface::WlSeat) => {
                self.pointer_seat.retain(|_, v| *v != id);
                self.touch_seat.retain(|_, v| *v != id);
            }
            Some(Iface::WlCompositor) if self.compositor_id == Some(id) => {
                self.compositor_id = None;
            }
            Some(Iface::XdgWmBase) if self.xdg_wm_base_id == Some(id) => {
                self.xdg_wm_base_id = None;
            }
            _ => {}
        }
        self.ifaces.remove(&id);
    }

    pub(crate) fn wl_surface_for_window_object(&self, id: u32, iface: Iface) -> Option<u32> {
        match iface {
            Iface::WlSurface => Some(id),
            Iface::XdgSurface => self.xdg_to_wl.get(&id).copied(),
            Iface::XdgToplevel | Iface::XdgPopupShim => self
                .top_to_xdg
                .get(&id)
                .and_then(|xdg_id| self.xdg_to_wl.get(xdg_id))
                .copied(),
            Iface::ZwlrLayerSurface => self.layer_windows.get(&id).map(|w| w.wl_surface),
            _ => None,
        }
    }

    /// The `wl_surface` behind a toplevel-like object.
    ///
    /// Covers both an ordinary `xdg_toplevel` and a window the proxy converted
    /// into a layer surface, which the client still addresses as a toplevel.
    pub(crate) fn toplevel_wl_surface(&self, toplevel_id: u32) -> Option<u32> {
        if let Some(layer) = self.layer_windows.get(&toplevel_id) {
            return Some(layer.wl_surface);
        }
        let xdg_id = self.top_to_xdg.get(&toplevel_id)?;
        self.xdg_to_wl.get(xdg_id).copied()
    }
}

#[cfg(test)]
mod tests {
    use super::super::layer_shell::{ANCHOR_ALL, LAYER_BACKGROUND};
    use super::super::test_support::{options, serial};

    use super::*;

    /// Serialize on the shared lock and start from empty policy state; the
    /// policy map is process-global, so every module that touches it does this.
    fn policy_fixture() -> std::sync::MutexGuard<'static, ()> {
        let guard = serial();
        init_state();
        clear_all_layer_policies();
        guard
    }

    /// A connection that already knows one surface and one window object.
    fn connected() -> WaylandConn {
        let mut conn = WaylandConn::new();
        conn.ifaces.insert(10, Iface::WlSurface);
        conn.ifaces.insert(20, Iface::XdgSurface);
        conn.ifaces.insert(30, Iface::XdgToplevel);
        conn.xdg_to_wl.insert(20, 10);
        conn.top_to_xdg.insert(30, 20);
        conn.wl_to_top.insert(10, 30);
        conn
    }

    #[test]
    fn a_new_connection_only_knows_the_display() {
        let conn = WaylandConn::new();

        assert_eq!(conn.ifaces.len(), 1);
        assert_eq!(conn.ifaces.get(&1), Some(&Iface::WlDisplay));
        assert!(conn.stolen_ids.is_empty());
        assert!(conn.injected_ids.is_empty());
    }

    #[test]
    fn resets_keep_the_display_but_drop_everything_else() {
        let mut conn = connected();
        conn.stolen_ids.push(99);
        conn.injected_ids.insert(99);
        conn.outputs.insert(77, Output::default());

        conn.reset_tracking();

        assert_eq!(conn.ifaces.len(), 1);
        assert!(conn.stolen_ids.is_empty());
        assert!(conn.injected_ids.is_empty());
        assert!(conn.top_to_xdg.is_empty());
        assert!(conn.outputs.is_empty());
    }

    #[test]
    fn an_output_name_is_read_from_the_live_connections() {
        let _serial = serial();
        init_state();
        let fd = 92_101;
        on_close(fd);

        let mut conn = WaylandConn::new();
        conn.outputs.insert(
            77,
            Output {
                objects: vec![900],
                name: Some("DP-1".into()),
            },
        );
        conn.outputs.insert(78, Output::default());
        CONNS.get().unwrap().lock().unwrap().insert(fd, conn);

        assert_eq!(output_name(77).as_deref(), Some("DP-1"));
        assert_eq!(output_name(78), None, "a display without a name has none");
        assert_eq!(output_name(79), None, "an unknown display has none");

        // The name belongs to the connection it was read from.
        on_close(fd);
        assert_eq!(output_name(77), None);
    }

    #[test]
    fn injected_ids_are_recycled_from_the_stolen_pool() {
        let mut conn = WaylandConn::new();
        conn.stolen_ids.extend([7, 8]);

        assert_eq!(conn.alloc_injected_id(), Some(8), "last in, first out");
        assert_eq!(conn.alloc_injected_id(), Some(7));
        assert_eq!(conn.alloc_injected_id(), None, "the pool is empty");
        assert!(conn.injected_ids.contains(&7) && conn.injected_ids.contains(&8));
        assert!(conn.stolen_ids.is_empty());
    }

    #[test]
    fn a_policy_follows_its_window_to_a_replacement_id() {
        let _serial = policy_fixture();
        let options = LayerShellOptions {
            namespace: "test".into(),
            ..Default::default()
        };

        assert!(set_layer_policy("source", options.clone()));
        assert!(transfer_window_role("source", "replacement"));

        assert_eq!(
            layer_policy("source"),
            None,
            "the discarded id keeps nothing"
        );
        assert_eq!(layer_policy("replacement"), Some(options));
        clear_all_layer_policies();
    }

    #[test]
    fn transferring_an_unknown_window_is_a_no_op() {
        let _serial = policy_fixture();

        assert!(transfer_window_role("missing", "replacement"));

        assert_eq!(layer_policy("replacement"), None);
        assert!(transfer_window_role("same", "same"));
    }

    #[test]
    fn purging_a_toplevel_clears_its_mappings() {
        let mut conn = connected();

        conn.purge(30);

        assert!(!conn.ifaces.contains_key(&30));
        assert!(!conn.top_to_xdg.contains_key(&30));
        assert!(!conn.wl_to_top.contains_key(&10));
        // The xdg surface it belonged to is untouched.
        assert!(conn.ifaces.contains_key(&20));
    }

    #[test]
    fn purging_an_xdg_surface_takes_its_toplevel_with_it() {
        let mut conn = connected();

        conn.purge(20);

        assert!(!conn.ifaces.contains_key(&20));
        assert!(!conn.ifaces.contains_key(&30), "toplevel is purged too");
        assert!(!conn.xdg_to_wl.contains_key(&20));
        assert!(!conn.top_to_xdg.contains_key(&30));
    }

    #[test]
    fn purging_a_surface_forgets_its_focus_and_toplevel() {
        let mut conn = connected();
        conn.pointer_focus.insert(40, 10);

        conn.purge(10);

        assert!(!conn.ifaces.contains_key(&10));
        assert!(!conn.wl_to_top.contains_key(&10));
        assert!(!conn.pointer_focus.contains_key(&40));
        // Mappings that pointed at the dead surface are dropped, so the xdg
        // surface no longer references it.
        assert!(!conn.xdg_to_wl.contains_key(&20));
        assert!(!conn.xdg_to_wl.values().any(|surface| *surface == 10));
    }

    #[test]
    fn purging_a_seat_forgets_the_devices_it_owned() {
        let mut conn = WaylandConn::new();
        conn.ifaces.insert(5, Iface::WlSeat);
        conn.pointer_seat.insert(6, 5);
        conn.touch_seat.insert(7, 5);
        conn.ifaces.insert(6, Iface::WlPointer);
        conn.ifaces.insert(7, Iface::WlTouch);

        conn.purge(5);

        assert!(conn.pointer_seat.is_empty());
        assert!(conn.touch_seat.is_empty());
    }

    #[test]
    fn purging_a_pointer_forgets_its_focus() {
        let mut conn = WaylandConn::new();
        conn.ifaces.insert(6, Iface::WlPointer);
        conn.pointer_focus.insert(6, 10);
        conn.pointer_seat.insert(6, 5);

        conn.purge(6);

        assert!(conn.pointer_focus.is_empty());
        assert!(conn.pointer_seat.is_empty());
    }

    #[test]
    fn window_objects_resolve_to_their_wl_surface() {
        let conn = connected();

        assert_eq!(
            conn.wl_surface_for_window_object(10, Iface::WlSurface),
            Some(10)
        );
        assert_eq!(
            conn.wl_surface_for_window_object(20, Iface::XdgSurface),
            Some(10)
        );
        assert_eq!(
            conn.wl_surface_for_window_object(30, Iface::XdgToplevel),
            Some(10)
        );
        assert_eq!(conn.wl_surface_for_window_object(1, Iface::WlDisplay), None);
        assert_eq!(
            conn.wl_surface_for_window_object(99, Iface::WlSurface),
            Some(99)
        );
    }

    #[test]
    fn policies_are_keyed_by_window_and_replaced_in_place() {
        let _serial = policy_fixture();

        assert!(!has_layer_policies());
        assert!(set_layer_policy("layer-a", options()));
        assert!(set_layer_policy("layer-b", options()));
        assert!(has_layer_policies());
        assert_eq!(layer_policy("foreign"), None);
        assert_eq!(layer_policy("layer-a"), Some(options()));
        assert_eq!(layer_policy("layer-b"), Some(options()));

        // Replacing a policy updates the window's entry, it does not append one.
        let replaced = LayerShellOptions {
            layer: LAYER_BACKGROUND,
            ..options()
        };
        assert!(set_layer_policy("layer-a", replaced.clone()));
        assert_eq!(layer_policy("layer-a"), Some(replaced));
        assert_eq!(layer_policy("layer-b"), Some(options()));

        assert!(clear_layer_policy("layer-a"));
        assert_eq!(layer_policy("layer-a"), None);
        assert!(has_layer_policies(), "layer-b is still registered");
        assert!(clear_layer_policy("layer-b"));
        assert!(!has_layer_policies());
        // Clearing a window without a policy is not an error.
        assert!(clear_layer_policy("layer-b"));
        clear_all_layer_policies();
    }

    #[test]
    fn a_window_holds_one_role_and_each_clear_owns_only_its_kind() {
        let _serial = policy_fixture();
        let fd = 93_700;
        clear_runtime_state_for_fd(fd);

        // A popup intent is not a layer policy, even though both live in the
        // same table.
        insert_popup_policy_for_test(fd, "role-window", "role-parent", 100, 80, 0, Some((4, 5)));
        assert!(layer_policy("role-window").is_none());
        assert!(popup_policy("role-window").is_some());
        assert!(!has_layer_policies());

        // Clearing the layer policy must not take a popup intent with it.
        assert!(clear_layer_policy("role-window"));
        assert!(popup_policy("role-window").is_some());
        assert!(clear_popup_policy("role-window"));
        assert!(popup_policy("role-window").is_none());
        assert!(!clear_popup_policy("role-window"), "already gone");

        // The window's one slot now holds a layer policy instead.
        assert!(set_layer_policy("role-window", options()));
        assert!(layer_policy("role-window").is_some());
        assert!(has_layer_policies());
        assert!(clear_window_role("role-window"));
        assert!(layer_policy("role-window").is_none());

        clear_runtime_state_for_fd(fd);
        clear_all_layer_policies();
    }

    #[test]
    fn invalid_options_are_rejected_before_a_policy_is_registered() {
        let _serial = policy_fixture();

        // The wayland-level setter applies the one implicit default and refuses
        // state the compositor would answer with a protocol error.
        let empty = LayerShellOptions {
            namespace: "open-orpheus-test".into(),
            ..Default::default()
        };
        assert!(super::super::set_layer_policy("defaulted", empty));
        assert_eq!(
            layer_policy("defaulted"),
            Some(LayerShellOptions {
                namespace: "open-orpheus-test".into(),
                anchor: ANCHOR_ALL,
                ..Default::default()
            })
        );

        let bad_layer = LayerShellOptions {
            layer: 4,
            ..options()
        };
        assert!(!super::super::set_layer_policy("bad-layer", bad_layer));
        assert_eq!(layer_policy("bad-layer"), None);
        assert!(
            LayerShellOptions::default().validate().is_err(),
            "no namespace"
        );
        clear_all_layer_policies();
    }

    #[test]
    fn role_decision_is_needed_only_while_something_could_decide_it() {
        let _serial = policy_fixture();
        let fd = 94_020;
        clear_runtime_state_for_fd(fd);

        assert!(!role_decision_needed(fd));

        assert!(set_policy(options()));
        assert!(
            role_decision_needed(fd),
            "a policy could decide a role on any connection"
        );

        clear_all_layer_policies();
        assert!(!role_decision_needed(fd));

        insert_popup_policy_for_test(fd, "menu-target", "menu-parent", 100, 80, 0, Some((0, 0)));
        assert!(role_decision_needed(fd), "a popup is waiting for this fd");
        assert!(
            !role_decision_needed(fd + 1),
            "another connection's popup does not matter"
        );

        clear_runtime_state_for_fd(fd);
        assert!(!role_decision_needed(fd));
    }
}

// ── Global state ───────────────────────────────────────────────────────────

pub(crate) static IS_WAYLAND: OnceLock<bool> = OnceLock::new();
pub(crate) static CONNS: OnceLock<Mutex<HashMap<RawFd, WaylandConn>>> = OnceLock::new();
#[derive(Clone, Copy)]
pub(crate) struct LastButton {
    pub(crate) fd: RawFd,
    pub(crate) seat_id: u32,
    pub(crate) serial: u32,
    pub(crate) wl_surface_id: u32,
    pub(crate) x: i32,
    pub(crate) y: i32,
    /// When the press arrived, so a caller can tell a deliberate click from a
    /// press that merely happened at some point in the past.
    pub(crate) at: Instant,
}

#[derive(Default)]
pub(crate) struct LastButtonState {
    pub(crate) by_surface: HashMap<(RawFd, u32), LastButton>,
    pub(crate) latest: Option<(RawFd, u32)>,
}

/// A popup role reserved for a managed window, stored in [`WindowRole`].
///
/// The window is identified the same way a layer policy is: the intent is
/// registered before the window's role exists and consumed by the role
/// transaction once the decorated title names the window. Only the intent is
/// recorded here — the parent's surface, the anchor and the positioner object id
/// are resolved when the role is actually created.
#[derive(Clone)]
pub(crate) struct PopupPolicy {
    pub(crate) parent_window_id: String,
    /// The connection the parent — and so the popup — is on. Registration is
    /// refused unless the parent is mapped there, so a policy can never name a
    /// connection that is already gone (or one that a reused descriptor now
    /// belongs to).
    pub(crate) parent_fd: RawFd,
    pub(crate) width: i32,
    pub(crate) height: i32,
    pub(crate) shadow_inset: i32,
    pub(crate) anchor: Option<(i32, i32)>,
}

pub(crate) static LAST_BUTTON: OnceLock<Mutex<LastButtonState>> = OnceLock::new();
pub(crate) type PointerAxisCb = Box<dyn FnOnce(Option<u32>) + Send>;
pub(crate) type PointerAxisWatcherKey = (RawFd, u32);
pub(crate) struct PointerAxisWatcher {
    pub(crate) token: u32,
    pub(crate) callback: PointerAxisCb,
}
pub(crate) type PointerAxisWatcherMap = HashMap<PointerAxisWatcherKey, Vec<PointerAxisWatcher>>;
pub(crate) static NEXT_POINTER_AXIS: OnceLock<Mutex<PointerAxisWatcherMap>> = OnceLock::new();
static NEXT_POINTER_AXIS_TOKEN: AtomicU32 = AtomicU32::new(1);
pub(crate) static RX_BUFS: OnceLock<Mutex<HashMap<RawFd, Vec<u8>>>> = OnceLock::new();
pub(crate) static TX_BUFS: OnceLock<Mutex<HashMap<RawFd, Vec<u8>>>> = OnceLock::new();

#[derive(Default)]
pub(crate) struct PendingControl {
    pub(crate) bytes: Vec<u8>,
    pub(crate) fds: Vec<RawFd>,
}

pub(crate) fn close_pending_control(pending: PendingControl) {
    for fd in pending.fds {
        super::super::proxy::syscalls::call_close(fd);
    }
}

// Pending control data (SCM_RIGHTS) stored alongside incomplete messages.
// Control data is semantically attached to a specific Wayland message on the same
// recvmsg boundary, so it must not be forwarded without the complete message.
pub(crate) static RX_PENDING_CTRL: OnceLock<Mutex<HashMap<RawFd, PendingControl>>> =
    OnceLock::new();
pub(crate) static TX_PENDING_CTRL: OnceLock<Mutex<HashMap<RawFd, PendingControl>>> =
    OnceLock::new();

// ── Managed window names ───────────────────────────────────────────────────

/// The connection and `wl_surface` a managed window id names.
///
/// The id rides in the decorated title and is stored per surface in
/// [`WaylandConn::surface_ids`]; this is the reverse lookup the injection and
/// popup paths need. There are only ever a couple of connections with a handful
/// of surfaces each, so a scan is cheaper than a second map with its own
/// invalidation rules.
pub(crate) fn window_surface(window_id: &str) -> Option<(RawFd, u32)> {
    let conns = CONNS.get()?.lock().ok()?;
    window_surface_in(&conns, window_id)
}

/// [`window_surface`] for a caller that already holds the connection lock.
pub(crate) fn window_surface_in(
    conns: &HashMap<RawFd, WaylandConn>,
    window_id: &str,
) -> Option<(RawFd, u32)> {
    conns.iter().find_map(|(fd, conn)| {
        conn.surface_ids
            .iter()
            .find(|(_, id)| id.as_str() == window_id)
            .map(|(surface, _)| (*fd, *surface))
    })
}

// ── Output names ───────────────────────────────────────────────────────────

/// The compositor's name for the output an application calls `display_id`.
///
/// A display id is one connection's registry global name; Chromium builds its
/// display cache from the connection it read that registry on, so the live
/// connections are scanned for the first one that has a name for the id.
pub(crate) fn output_name(display_id: u32) -> Option<String> {
    let conns = CONNS.get()?.lock().ok()?;
    conns
        .values()
        .find_map(|conn| conn.outputs.get(&display_id)?.name.clone())
}

// ── Window roles ───────────────────────────────────────────────────────────

/// The role a managed window asked its surface to take.
///
/// One per window, because a surface takes exactly one role and the compositor
/// keeps it for the surface's whole life. Keyed by the id the application names
/// the window with, so it can be registered before the window (or its surface)
/// exists; it is consulted when a surface's role transaction resolves that id,
/// after which the decided role lives in `WaylandConn::surface_roles`.
#[derive(Clone)]
pub(crate) enum WindowRole {
    /// Layer-shell options. Kept once the role is taken, so the window's next
    /// surface applies them again.
    Layer(LayerShellOptions),
    /// A popup intent with the size the renderer measured. Taken when the role
    /// is actually created.
    Popup(PopupPolicy),
}

static WINDOW_ROLES: OnceLock<Mutex<HashMap<String, WindowRole>>> = OnceLock::new();

fn window_roles() -> Option<&'static Mutex<HashMap<String, WindowRole>>> {
    WINDOW_ROLES.get()
}

/// The role a managed window registered, if any.
fn window_role(window_id: &str) -> Option<WindowRole> {
    window_roles()?.lock().ok()?.get(window_id).cloned()
}

/// Whether a connection knows a compositor that takes layer surfaces.
///
/// Derived from the live connections rather than remembered in a flag, so a
/// compositor that withdraws the global stops being reported as available.
pub(crate) fn is_layer_shell_available() -> bool {
    let Some(conns) = CONNS.get() else {
        return false;
    };
    let Ok(conns) = conns.lock() else {
        return false;
    };
    conns.values().any(|conn| conn.layer_shell_global.is_some())
}

/// Register (or replace) the layer-shell policy for a managed window.
pub(crate) fn set_layer_policy(window_id: &str, options: LayerShellOptions) -> bool {
    let Some(roles) = window_roles() else {
        return false;
    };
    let Ok(mut roles) = roles.lock() else {
        return false;
    };
    roles.insert(window_id.to_string(), WindowRole::Layer(options));
    true
}

/// Withdraw the layer-shell policy for a managed window.
///
/// A surface that already took the layer role keeps it for its life; only the
/// window's next surface (a re-created window) is affected.
pub(crate) fn clear_layer_policy(window_id: &str) -> bool {
    let Some(roles) = window_roles() else {
        return true;
    };
    let Ok(mut roles) = roles.lock() else {
        return false;
    };
    if matches!(roles.get(window_id), Some(WindowRole::Layer(_))) {
        roles.remove(window_id);
    }
    true
}

/// The layer-shell policy a managed window registered, if any.
pub(crate) fn layer_policy(window_id: &str) -> Option<LayerShellOptions> {
    match window_role(window_id)? {
        WindowRole::Layer(options) => Some(options),
        WindowRole::Popup(_) => None,
    }
}

/// Whether any window has a layer-shell policy that could still apply.
pub(crate) fn has_layer_policies() -> bool {
    window_roles().is_some_and(|roles| {
        roles.lock().is_ok_and(|roles| {
            roles
                .values()
                .any(|role| matches!(role, WindowRole::Layer(_)))
        })
    })
}

/// Whether a role creation on `fd` needs the window identity before deciding.
///
/// A layer policy is registered before its window exists, so it has no
/// connection to name and holds role creations everywhere; a popup knows its
/// parent's connection and holds only that one.
pub(crate) fn role_decision_needed(fd: RawFd) -> bool {
    has_layer_policies() || popup_waits_on(fd)
}

fn popup_waits_on(fd: RawFd) -> bool {
    window_roles().is_some_and(|roles| {
        roles.lock().is_ok_and(|roles| {
            roles.values().any(|role| match role {
                WindowRole::Popup(policy) => policy.parent_fd == fd,
                WindowRole::Layer(_) => false,
            })
        })
    })
}

/// Re-key whatever role a managed window registered under another window id.
///
/// A policy switch replaces the wrapper, and the replacement is a different
/// window with a different id; the role has to follow it so the replacement's
/// first role creation sees it.
pub(crate) fn transfer_window_role(from_id: &str, to_id: &str) -> bool {
    if from_id == to_id {
        return true;
    }
    let Some(roles) = window_roles() else {
        return false;
    };
    let Ok(mut roles) = roles.lock() else {
        return false;
    };
    if let Some(role) = roles.remove(from_id) {
        roles.insert(to_id.to_string(), role);
    }
    true
}

/// Drop whatever role a window will not use after all.
pub(crate) fn clear_window_role(window_id: &str) -> bool {
    let Some(roles) = window_roles() else {
        return true;
    };
    let Ok(mut roles) = roles.lock() else {
        return false;
    };
    roles.remove(window_id);
    true
}

/// Test shorthand for registering an unnamed policy.
#[cfg(test)]
pub(crate) fn set_policy(options: LayerShellOptions) -> bool {
    set_layer_policy("test-window", options)
}

/// Test helper: drop every layer policy so cases do not leak into each other.
#[cfg(test)]
pub(crate) fn clear_all_layer_policies() {
    if let Some(roles) = window_roles()
        && let Ok(mut roles) = roles.lock()
    {
        roles.retain(|_, role| !matches!(role, WindowRole::Layer(_)));
    }
}

pub(crate) type CursorEnterCb = Box<dyn FnOnce(Option<(i32, i32)>) + Send>;
pub(crate) struct CursorEnterWatcher {
    pub(crate) token: u32,
    pub(crate) callback: CursorEnterCb,
}
pub(crate) type CursorEnterWatcherKey = (RawFd, u32);
pub(crate) type CursorEnterWatcherMap = HashMap<CursorEnterWatcherKey, Vec<CursorEnterWatcher>>;
pub(crate) static NEXT_TOPLEVEL_CURSOR_ENTER: OnceLock<Mutex<Vec<CursorEnterWatcher>>> =
    OnceLock::new();
pub(crate) static CURSOR_ENTER_WATCHERS: OnceLock<Mutex<CursorEnterWatcherMap>> = OnceLock::new();
static NEXT_CURSOR_ENTER_TOKEN: AtomicU32 = AtomicU32::new(1);

fn next_unused_token(counter: &AtomicU32, mut is_used: impl FnMut(u32) -> bool) -> u32 {
    loop {
        let token = counter.fetch_add(1, Ordering::Relaxed);
        if token != 0 && !is_used(token) {
            return token;
        }
    }
}

// ── Cursor enter watchers ─────────────────────────────────────────────────

pub(crate) fn arm_first_cursor_enter_watchers(fd: RawFd, wl_surface_id: u32) {
    let Some(pending) = NEXT_TOPLEVEL_CURSOR_ENTER.get() else {
        return;
    };
    let Ok(mut pending) = pending.lock() else {
        return;
    };
    if pending.is_empty() {
        return;
    }
    let mut callbacks: Vec<_> = pending.drain(..).collect();
    // Keep pending locked until transfer finishes so cancellation cannot miss
    // a watcher between the pending and armed collections.
    if let Some(watchers) = CURSOR_ENTER_WATCHERS.get()
        && let Ok(mut watchers) = watchers.lock()
    {
        watchers
            .entry((fd, wl_surface_id))
            .or_default()
            .append(&mut callbacks);
        return;
    }
    drop(pending);
    for watcher in callbacks {
        (watcher.callback)(None);
    }
}

pub(crate) fn watch_next_toplevel_cursor_enter(callback: CursorEnterCb) -> Option<u32> {
    let Some(pending) = NEXT_TOPLEVEL_CURSOR_ENTER.get() else {
        callback(None);
        return None;
    };
    let Ok(mut pending) = pending.lock() else {
        callback(None);
        return None;
    };
    let token = next_unused_token(&NEXT_CURSOR_ENTER_TOKEN, |candidate| {
        pending.iter().any(|watcher| watcher.token == candidate)
            || CURSOR_ENTER_WATCHERS
                .get()
                .and_then(|watchers| watchers.lock().ok())
                .is_some_and(|watchers| {
                    watchers
                        .values()
                        .flatten()
                        .any(|watcher| watcher.token == candidate)
                })
    });
    pending.push(CursorEnterWatcher { token, callback });
    Some(token)
}

pub(crate) fn cancel_cursor_enter_watcher(token: u32) -> bool {
    let pending_watcher = NEXT_TOPLEVEL_CURSOR_ENTER.get().and_then(|pending| {
        let mut pending = pending.lock().ok()?;
        let index = pending.iter().position(|watcher| watcher.token == token)?;
        Some(pending.remove(index))
    });
    if let Some(watcher) = pending_watcher {
        (watcher.callback)(None);
        return true;
    }

    let armed_watcher = CURSOR_ENTER_WATCHERS.get().and_then(|watchers| {
        let mut watchers = watchers.lock().ok()?;
        let mut removed = None;
        watchers.retain(|_, entries| {
            if removed.is_none()
                && let Some(index) = entries.iter().position(|watcher| watcher.token == token)
            {
                removed = Some(entries.remove(index));
            }
            !entries.is_empty()
        });
        removed
    });
    if let Some(watcher) = armed_watcher {
        (watcher.callback)(None);
        true
    } else {
        false
    }
}

pub(crate) fn fire_first_cursor_enter_watchers(fd: RawFd, wl_surface_id: u32, x: i32, y: i32) {
    let Some(watchers) = CURSOR_ENTER_WATCHERS.get() else {
        return;
    };
    let callbacks = {
        let Ok(mut watchers) = watchers.lock() else {
            return;
        };
        watchers.remove(&(fd, wl_surface_id))
    };
    if let Some(watchers) = callbacks {
        for watcher in watchers {
            (watcher.callback)(Some((x, y)));
        }
    }
}

pub(crate) fn clear_first_cursor_enter_watchers_for_fd(fd: RawFd) {
    let removed = CURSOR_ENTER_WATCHERS.get().and_then(|watchers| {
        let mut watchers = watchers.lock().ok()?;
        let mut removed = Vec::new();
        watchers.retain(|(watch_fd, _), entries| {
            if *watch_fd == fd {
                removed.append(entries);
                false
            } else {
                true
            }
        });
        Some(removed)
    });
    if let Some(watchers) = removed {
        for watcher in watchers {
            (watcher.callback)(None);
        }
    }
}

pub(crate) fn clear_first_cursor_enter_watchers_for_surface(fd: RawFd, wl_surface_id: u32) {
    let watchers = CURSOR_ENTER_WATCHERS
        .get()
        .and_then(|watchers| watchers.lock().ok()?.remove(&(fd, wl_surface_id)));
    if let Some(watchers) = watchers {
        for watcher in watchers {
            (watcher.callback)(None);
        }
    }
}

pub(crate) fn clear_last_button_for_surface(fd: RawFd, wl_surface_id: u32) {
    if let Some(last_button) = LAST_BUTTON.get()
        && let Ok(mut last_button) = last_button.lock()
    {
        last_button.by_surface.remove(&(fd, wl_surface_id));
        if last_button.latest == Some((fd, wl_surface_id)) {
            last_button.latest = None;
        }
    }
}

// ── Refused layer-shell roles ─────────────────────────────────────────────

/// Reports a window whose surface could not take the layer role, by the custom
/// window id the application knows it under.
///
/// The role cannot be applied to an existing surface, so the application has to
/// re-create the window; without this the failure is silent.
pub(crate) type LayerShellRefusedCb = Box<dyn Fn(String) + Send + Sync>;

pub(crate) static LAYER_SHELL_REFUSED: OnceLock<Mutex<Option<LayerShellRefusedCb>>> =
    OnceLock::new();

/// Register the one listener for refused roles.
pub(crate) fn on_layer_shell_refused(cb: LayerShellRefusedCb) -> bool {
    let slot = LAYER_SHELL_REFUSED.get_or_init(|| Mutex::new(None));
    let Ok(mut slot) = slot.lock() else {
        return false;
    };
    *slot = Some(cb);
    true
}

pub(crate) fn fire_layer_shell_refused(window_id: String) {
    let Some(slot) = LAYER_SHELL_REFUSED.get() else {
        return;
    };
    let Ok(slot) = slot.lock() else {
        return;
    };
    if let Some(callback) = slot.as_ref() {
        callback(window_id);
    }
}

/// Register the intent to present `target_window_id` as an xdg_popup of
/// `parent_window_id`, with the size the renderer measured.
///
/// Nothing is resolved here: the parent's surface, the anchor and the positioner
/// object id are all taken when the role is created and the decorated title
/// names the window, so registering the intent cannot fail for want of them.
/// Returns whether it was accepted; a window whose surface already took a role
/// can never be a popup, and is refused now rather than shown as an ordinary
/// toplevel first.
pub(crate) fn set_popup_policy(
    target_window_id: &str,
    parent_window_id: &str,
    width: i32,
    height: i32,
    anchor: Option<(i32, i32)>,
    shadow_inset: i32,
) -> bool {
    if width <= 0 || height <= 0 || width > MAX_POPUP_DIMENSION || height > MAX_POPUP_DIMENSION {
        return false;
    }
    if shadow_inset < 0 || shadow_inset > (width.min(height) - 1) / 2 {
        return false;
    }

    // One lock for the whole exchange — look the parent up, check the target,
    // publish the policy — so a connection close cannot land in the middle and
    // leave a policy naming a descriptor that is gone (and that some later
    // connection may reuse). `on_close` removes the connection under this same
    // lock, so the two orderings are "registered, then pruned" and "closed,
    // then refused"; there is no third.
    let Some(conns) = CONNS.get() else {
        return false;
    };
    let Ok(conns) = conns.lock() else {
        return false;
    };

    // A popup is anchored to a mapped parent: without one there is no surface
    // to resolve and no window for it to appear next to.
    let Some((parent_fd, _)) = window_surface_in(&conns, parent_window_id) else {
        return false;
    };

    // Some compositors create the hidden window's role before show. That role is
    // permanent, so refuse before the caller shows an ordinary toplevel.
    let took_role = window_surface_in(&conns, target_window_id).is_some_and(|(fd, surface)| {
        conns
            .get(&fd)
            .map(|conn| {
                conn.surface_ids.get(&surface).map(String::as_str) != Some(target_window_id)
                    || conn.wl_to_top.contains_key(&surface)
                    || matches!(
                        conn.surface_roles.get(&surface),
                        Some(SurfaceRole::Layer(_))
                    )
            })
            .unwrap_or(false)
    });
    if took_role {
        return false;
    }

    let Some(roles) = window_roles() else {
        return false;
    };
    let Ok(mut roles) = roles.lock() else {
        return false;
    };
    roles.insert(
        target_window_id.to_string(),
        WindowRole::Popup(PopupPolicy {
            parent_window_id: parent_window_id.to_string(),
            parent_fd,
            width,
            height,
            shadow_inset,
            anchor,
        }),
    );
    true
}

/// The popup intent recorded for `window_id`, if that is its role.
pub(crate) fn popup_policy(window_id: &str) -> Option<PopupPolicy> {
    match window_role(window_id)? {
        WindowRole::Popup(policy) => Some(policy),
        WindowRole::Layer(_) => None,
    }
}

/// Drop the popup intent for `window_id` once its role has actually become a
/// popup.
pub(crate) fn take_popup_policy(window_id: &str) -> Option<PopupPolicy> {
    let mut roles = window_roles()?.lock().ok()?;
    if !matches!(roles.get(window_id), Some(WindowRole::Popup(_))) {
        return None;
    }
    match roles.remove(window_id) {
        Some(WindowRole::Popup(policy)) => Some(policy),
        _ => None,
    }
}

/// Withdraw a popup intent the window will not use after all.
pub(crate) fn clear_popup_policy(window_id: &str) -> bool {
    let Some(roles) = window_roles() else {
        return false;
    };
    let Ok(mut roles) = roles.lock() else {
        return false;
    };
    if !matches!(roles.get(window_id), Some(WindowRole::Popup(_))) {
        return false;
    }
    roles.remove(window_id).is_some()
}

/// Register a policy as the menu does, without a real parent surface.
#[cfg(test)]
pub(crate) fn insert_popup_policy_for_test(
    fd: RawFd,
    target: &str,
    parent: &str,
    width: i32,
    height: i32,
    shadow_inset: i32,
    anchor: Option<(i32, i32)>,
) {
    WINDOW_ROLES
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .insert(
            target.to_string(),
            WindowRole::Popup(PopupPolicy {
                parent_window_id: parent.to_string(),
                parent_fd: fd,
                width,
                height,
                shadow_inset,
                anchor,
            }),
        );
}

/// How long ago the most recent pointer button press was made in `window_id`.
///
/// `None` when that press, if there was one, landed somewhere else: the caller
/// is asking whether *this* window was the last one clicked. A stale press and a
/// press in another window are the same answer, because neither proves the user
/// is working here now.
pub(crate) fn window_last_press_age(window_id: &str) -> Option<Duration> {
    let (fd, wl_surface_id) = window_surface(window_id)?;
    let buttons = LAST_BUTTON.get()?.lock().ok()?;
    if buttons.latest != Some((fd, wl_surface_id)) {
        return None;
    }
    Some(buttons.by_surface.get(&(fd, wl_surface_id))?.at.elapsed())
}

/// Whether a pointer is currently over the surface that names `window_id`.
///
/// The compositor sends `wl_pointer.enter` and `leave` for the surface under
/// the pointer, so this is occlusion-correct: a pointer that moved onto a
/// window covering this one is not "inside" it.
pub(crate) fn window_pointer_inside(window_id: &str) -> bool {
    let Some((fd, wl_surface_id)) = window_surface(window_id) else {
        return false;
    };
    CONNS
        .get()
        .and_then(|conns| conns.lock().ok())
        .and_then(|conns| {
            let conn = conns.get(&fd)?;
            Some(
                conn.pointer_focus
                    .values()
                    .any(|surface| *surface == wl_surface_id),
            )
        })
        .unwrap_or(false)
}

pub(crate) fn window_is_popup(window_id: &str) -> bool {
    let Some((fd, wl_surface_id)) = window_surface(window_id) else {
        return false;
    };
    let details = CONNS
        .get()
        .and_then(|conns| conns.lock().ok())
        .and_then(|conns| {
            let conn = conns.get(&fd)?;
            let top_id = conn.wl_to_top.get(&wl_surface_id)?;
            Some((*top_id, conn.ifaces.get(top_id).copied()))
        });
    details.is_some_and(|(_, iface)| iface == Some(Iface::XdgPopupShim))
}

pub(crate) fn watch_next_pointer_axis(window_id: &str, callback: PointerAxisCb) -> Option<u32> {
    let registration = (|| {
        let conns = CONNS.get()?.lock().ok()?;
        let (fd, wl_surface_id) = window_surface_in(&conns, window_id)?;
        Some((conns, fd, wl_surface_id))
    })();
    let Some((conns, fd, wl_surface_id)) = registration else {
        callback(None);
        return None;
    };
    let Some(watchers) = NEXT_POINTER_AXIS.get() else {
        drop(conns);
        callback(None);
        return None;
    };
    let Ok(mut watchers) = watchers.lock() else {
        drop(conns);
        callback(None);
        return None;
    };
    let token = next_unused_token(&NEXT_POINTER_AXIS_TOKEN, |candidate| {
        watchers
            .values()
            .flatten()
            .any(|watcher| watcher.token == candidate)
    });
    watchers
        .entry((fd, wl_surface_id))
        .or_default()
        .push(PointerAxisWatcher { token, callback });
    drop(watchers);
    drop(conns);
    Some(token)
}

pub(crate) fn cancel_pointer_axis_watcher(token: u32) -> bool {
    let Some(watchers) = NEXT_POINTER_AXIS.get() else {
        return false;
    };
    let watcher = {
        let Ok(mut watchers) = watchers.lock() else {
            return false;
        };
        let mut removed = None;
        watchers.retain(|_, entries| {
            if removed.is_none()
                && let Some(index) = entries.iter().position(|entry| entry.token == token)
            {
                removed = Some(entries.remove(index));
            }
            !entries.is_empty()
        });
        removed
    };
    if let Some(watcher) = watcher {
        (watcher.callback)(None);
        true
    } else {
        false
    }
}

pub(crate) fn fire_next_pointer_axis(fd: RawFd, wl_surface_id: u32, axis: u32) {
    let watchers = NEXT_POINTER_AXIS
        .get()
        .and_then(|watchers| watchers.lock().ok()?.remove(&(fd, wl_surface_id)));
    if let Some(watchers) = watchers {
        for watcher in watchers {
            (watcher.callback)(Some(axis));
        }
    }
}

pub(crate) fn clear_pointer_axis_watchers_for_surface(fd: RawFd, wl_surface_id: u32) {
    let watchers = NEXT_POINTER_AXIS
        .get()
        .and_then(|watchers| watchers.lock().ok()?.remove(&(fd, wl_surface_id)));
    if let Some(watchers) = watchers {
        for watcher in watchers {
            (watcher.callback)(None);
        }
    }
}

pub(crate) fn clear_runtime_state_for_fd(fd: RawFd) {
    if let Some(m) = LAST_BUTTON.get()
        && let Ok(mut buttons) = m.lock()
    {
        buttons
            .by_surface
            .retain(|(button_fd, _), _| *button_fd != fd);
        if buttons.latest.is_some_and(|(button_fd, _)| button_fd == fd) {
            buttons.latest = None;
        }
    }
    // A popup that never got its window is dropped with the connection it would
    // have been created on. A layer policy has no connection to go stale with.
    if let Some(roles) = WINDOW_ROLES.get()
        && let Ok(mut roles) = roles.lock()
    {
        roles
            .retain(|_, role| !matches!(role, WindowRole::Popup(policy) if policy.parent_fd == fd));
    }
    let axis_watchers = NEXT_POINTER_AXIS.get().and_then(|m| {
        let mut watchers = m.lock().ok()?;
        let mut removed = Vec::new();
        watchers.retain(|(watch_fd, _), entries| {
            if *watch_fd == fd {
                removed.append(entries);
                false
            } else {
                true
            }
        });
        Some(removed)
    });
    if let Some(watchers) = axis_watchers {
        for watcher in watchers {
            (watcher.callback)(None);
        }
    }
    clear_first_cursor_enter_watchers_for_fd(fd);
}

pub(crate) fn clear_stream_state_for_fd(fd: RawFd) {
    if let Some(m) = RX_BUFS.get() {
        let _ = m.lock().map(|mut buffers| buffers.remove(&fd));
    }
    if let Some(m) = TX_BUFS.get() {
        let _ = m.lock().map(|mut buffers| buffers.remove(&fd));
    }
    for controls in [&RX_PENDING_CTRL, &TX_PENDING_CTRL] {
        if let Some(controls) = controls.get()
            && let Ok(mut controls) = controls.lock()
            && let Some(pending) = controls.remove(&fd)
        {
            close_pending_control(pending);
        }
    }
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

pub(crate) fn on_close(fd: RawFd) {
    if let Some(m) = CONNS.get()
        && let Ok(mut map) = m.lock()
    {
        map.remove(&fd);
    }
    clear_runtime_state_for_fd(fd);
    clear_stream_state_for_fd(fd);
}

pub(crate) fn is_wayland() -> bool {
    *IS_WAYLAND.get().unwrap_or(&false)
}

pub(crate) fn init_state() {
    CONNS.get_or_init(|| Mutex::new(HashMap::new()));
    LAST_BUTTON.get_or_init(|| Mutex::new(LastButtonState::default()));
    WINDOW_ROLES.get_or_init(|| Mutex::new(HashMap::new()));
    NEXT_POINTER_AXIS.get_or_init(|| Mutex::new(HashMap::new()));
    RX_BUFS.get_or_init(|| Mutex::new(HashMap::new()));
    TX_BUFS.get_or_init(|| Mutex::new(HashMap::new()));
    RX_PENDING_CTRL.get_or_init(|| Mutex::new(HashMap::new()));
    TX_PENDING_CTRL.get_or_init(|| Mutex::new(HashMap::new()));
    NEXT_TOPLEVEL_CURSOR_ENTER.get_or_init(|| Mutex::new(Vec::new()));
    CURSOR_ENTER_WATCHERS.get_or_init(|| Mutex::new(HashMap::new()));
}

pub(crate) fn clear_state() {
    if let Some(m) = CONNS.get()
        && let Ok(mut map) = m.lock()
    {
        map.clear();
    }
    if let Some(m) = LAST_BUTTON.get()
        && let Ok(mut buttons) = m.lock()
    {
        buttons.by_surface.clear();
        buttons.latest = None;
    }
    if let Some(m) = WINDOW_ROLES.get()
        && let Ok(mut roles) = m.lock()
    {
        roles.clear();
    }
    let axis_watchers = NEXT_POINTER_AXIS.get().and_then(|m| {
        let mut watchers = m.lock().ok()?;
        Some(
            watchers
                .drain()
                .flat_map(|(_, entries)| entries)
                .collect::<Vec<_>>(),
        )
    });
    if let Some(watchers) = axis_watchers {
        for watcher in watchers {
            (watcher.callback)(None);
        }
    }
    if let Some(m) = RX_BUFS.get()
        && let Ok(mut map) = m.lock()
    {
        map.clear();
    }
    if let Some(m) = TX_BUFS.get()
        && let Ok(mut map) = m.lock()
    {
        map.clear();
    }
    if let Some(m) = RX_PENDING_CTRL.get()
        && let Ok(mut map) = m.lock()
    {
        for pending in map.drain().map(|(_, pending)| pending) {
            close_pending_control(pending);
        }
    }
    if let Some(m) = TX_PENDING_CTRL.get()
        && let Ok(mut map) = m.lock()
    {
        for pending in map.drain().map(|(_, pending)| pending) {
            close_pending_control(pending);
        }
    }
    let pending_cursor_watchers = NEXT_TOPLEVEL_CURSOR_ENTER
        .get()
        .and_then(|pending| Some(pending.lock().ok()?.drain(..).collect::<Vec<_>>()));
    if let Some(watchers) = pending_cursor_watchers {
        for watcher in watchers {
            (watcher.callback)(None);
        }
    }
    let cursor_watchers = CURSOR_ENTER_WATCHERS.get().and_then(|watchers| {
        Some(
            watchers
                .lock()
                .ok()?
                .drain()
                .flat_map(|(_, entries)| entries)
                .collect::<Vec<_>>(),
        )
    });
    if let Some(watchers) = cursor_watchers {
        for watcher in watchers {
            (watcher.callback)(None);
        }
    }
}

#[cfg(test)]
mod popup_tests {
    use std::{
        sync::{
            Arc,
            atomic::{AtomicU32, Ordering},
        },
        time::{Duration, Instant},
    };

    use super::*;

    #[test]
    fn the_press_clock_and_pointer_are_read_per_window() {
        let _guard = serial();
        init_state();
        let fd = 93_300;
        clear_runtime_state_for_fd(fd);
        let mut conn = WaylandConn::new();
        conn.surface_ids.insert(10, "press-window".into());
        conn.surface_ids.insert(11, "other-window".into());
        conn.pointer_focus.insert(40, 10);
        CONNS.get().unwrap().lock().unwrap().insert(fd, conn);

        // The pointer is over one window's surface, not the other's.
        assert!(window_pointer_inside("press-window"));
        assert!(!window_pointer_inside("other-window"));

        // A press in the window is fresh; the same press is not an answer for
        // another window, and a press recorded elsewhere is not an answer for
        // this one.
        let buttons = LAST_BUTTON.get().unwrap();
        {
            let mut buttons = buttons.lock().unwrap();
            for (surface, serial) in [(10_u32, 2_u32), (11, 3)] {
                buttons.by_surface.insert(
                    (fd, surface),
                    LastButton {
                        fd,
                        seat_id: 1,
                        serial,
                        wl_surface_id: surface,
                        x: 0,
                        y: 0,
                        at: Instant::now(),
                    },
                );
            }
            buttons.latest = Some((fd, 10));
        }
        assert!(
            window_last_press_age("press-window").is_some_and(|age| age < Duration::from_secs(1))
        );
        assert!(window_last_press_age("other-window").is_none());

        buttons.lock().unwrap().latest = Some((fd, 11));
        assert!(window_last_press_age("press-window").is_none());
        assert!(window_last_press_age("other-window").is_some());

        on_close(fd);
    }

    // These interleavings observe the same global connection lock, so they
    // serialize on the one test mutex every global-touching module shares: one
    // race cannot satisfy another's "connection locked" checkpoint before its
    // worker has reached it.
    use super::super::test_support::{SERIAL as CONNECTION_RACES, serial};

    fn wait_for_connection_lock() {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if matches!(
                CONNS.get().unwrap().try_lock(),
                Err(std::sync::TryLockError::WouldBlock)
            ) {
                return;
            }
            assert!(Instant::now() < deadline, "operation did not acquire CONNS");
            std::thread::yield_now();
        }
    }

    #[test]
    fn axis_registration_is_atomic_with_close_and_rejects_stale_identity() {
        let _guard = CONNECTION_RACES.lock().unwrap();
        init_state();
        let fd = 93_602;
        let mut conn = WaylandConn::new();
        conn.surface_ids.insert(10, "axis-owner".into());
        CONNS.get().unwrap().lock().unwrap().insert(fd, conn);
        let callbacks = Arc::new(AtomicU32::new(0));
        let counter = callbacks.clone();
        let watchers = NEXT_POINTER_AXIS.get().unwrap().lock().unwrap();
        let registering = std::thread::spawn(move || {
            watch_next_pointer_axis(
                "axis-owner",
                Box::new(move |axis| {
                    assert!(axis.is_none());
                    counter.fetch_add(1, Ordering::Relaxed);
                }),
            )
        });
        wait_for_connection_lock();
        let closing = std::thread::spawn(move || on_close(fd));
        drop(watchers);
        assert!(registering.join().unwrap().is_some());
        closing.join().unwrap();
        assert_eq!(callbacks.load(Ordering::Relaxed), 1);
        assert!(
            !NEXT_POINTER_AXIS
                .get()
                .unwrap()
                .lock()
                .unwrap()
                .contains_key(&(fd, 10))
        );
        let mut replacement = WaylandConn::new();
        replacement.surface_ids.insert(10, "other-owner".into());
        CONNS.get().unwrap().lock().unwrap().insert(fd, replacement);
        assert!(
            watch_next_pointer_axis("axis-owner", Box::new(|axis| assert!(axis.is_none())))
                .is_none()
        );
        on_close(fd);
    }

    #[test]
    fn a_popup_policy_is_dropped_with_its_connection() {
        let _guard = CONNECTION_RACES.lock().unwrap();
        init_state();
        let fd = 93_001;
        let parent_id = "popup-parent";
        let target_id = "popup-target";
        let mut conn = WaylandConn::new();
        conn.surface_ids.insert(10, parent_id.into());
        CONNS.get().unwrap().lock().unwrap().insert(fd, conn);

        assert!(set_popup_policy(
            target_id,
            parent_id,
            100,
            80,
            Some((4, 5)),
            0
        ));
        assert!(popup_policy(target_id).is_some());

        // Registering the intent checks nothing out of the connection, so a
        // close leaves no reserved object id behind for a reused descriptor.
        on_close(fd);
        assert!(popup_policy(target_id).is_none());

        let mut replacement = WaylandConn::new();
        replacement.surface_ids.insert(10, "other-window".into());
        CONNS.get().unwrap().lock().unwrap().insert(fd, replacement);
        assert!(popup_policy(target_id).is_none());
        on_close(fd);
    }

    #[test]
    fn an_already_assigned_target_role_cannot_become_a_popup() {
        let _guard = CONNECTION_RACES.lock().unwrap();
        init_state();
        let fd = 93_005;
        let parent_id = "popup-assigned-parent";
        let target_id = "popup-assigned-target";
        let mut conn = WaylandConn::new();
        conn.surface_ids.insert(10, parent_id.into());
        conn.surface_ids.insert(11, target_id.into());
        conn.wl_to_top.insert(11, 31);
        conn.ifaces.insert(31, Iface::XdgToplevel);
        CONNS.get().unwrap().lock().unwrap().insert(fd, conn);

        // Refused before the caller shows an ordinary toplevel it would then
        // have to replace with the overlay.
        assert!(!set_popup_policy(
            target_id,
            parent_id,
            100,
            80,
            Some((4, 5)),
            0
        ));
        assert!(popup_policy(target_id).is_none());
        on_close(fd);
    }

    #[test]
    fn a_popup_policy_needs_a_mapped_parent_and_a_sane_size() {
        let _guard = serial();
        init_state();
        // Impossible geometry is refused up front, so the caller can fall back
        // without showing anything.
        assert!(!set_popup_policy("bad-size", "parent", 0, 80, None, 0));
        assert!(!set_popup_policy("bad-inset", "parent", 10, 10, None, 9));
        assert!(popup_policy("bad-size").is_none());
        assert!(popup_policy("bad-inset").is_none());

        // An unmapped parent cannot anchor a popup.
        assert!(!set_popup_policy("target", "not-up-yet", 100, 80, None, 0));
        assert!(popup_policy("target").is_none());

        // Once it is mapped, the intent is accepted and names its connection.
        let fd = 93_006;
        clear_runtime_state_for_fd(fd);
        let mut conn = WaylandConn::new();
        conn.surface_ids.insert(10, "not-up-yet".into());
        CONNS.get().unwrap().lock().unwrap().insert(fd, conn);
        assert!(set_popup_policy("target", "not-up-yet", 100, 80, None, 0));
        let policy = popup_policy("target").expect("accepted");
        assert_eq!(policy.parent_fd, fd);
        assert_eq!(policy.anchor, None);
        clear_popup_policy("target");
        on_close(fd);
    }

    #[test]
    fn an_unmapped_parent_is_refused_instead_of_holding_other_connections() {
        let _guard = serial();
        init_state();
        let fd = 93_002;
        let other_fd = 93_003;
        clear_runtime_state_for_fd(fd);
        clear_runtime_state_for_fd(other_fd);
        let mut replacement = WaylandConn::new();
        replacement.surface_ids.insert(10, "new-window".into());
        CONNS.get().unwrap().lock().unwrap().insert(fd, replacement);

        // Nothing to anchor to, so the caller keeps its overlay rather than
        // leaving a policy that would make role creations wait on a connection
        // the popup does not belong to.
        assert!(!set_popup_policy(
            "target",
            "parent-unknown",
            100,
            80,
            Some((0, 0)),
            0
        ));
        assert!(popup_policy("target").is_none());
        assert!(!role_decision_needed(fd));
        assert!(!role_decision_needed(other_fd));

        on_close(fd);
        on_close(other_fd);
    }

    #[test]
    fn a_popup_policy_only_names_its_own_window() {
        let _guard = serial();
        init_state();
        let fd = 93_501;
        clear_runtime_state_for_fd(fd);
        insert_popup_policy_for_test(fd, "target", "parent", 100, 80, 0, Some((4, 5)));

        assert!(popup_policy("old-window").is_none());
        assert!(popup_policy("unrelated-new-window").is_none());
        assert_eq!(popup_policy("target").unwrap().width, 100);
        assert!(take_popup_policy("target").is_some());
        assert!(popup_policy("target").is_none());
        clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn runtime_state_cleanup_is_connection_and_surface_scoped() {
        let _guard = serial();
        init_state();
        let fd = 91_001;
        let other_fd = 91_002;
        clear_runtime_state_for_fd(fd);
        clear_runtime_state_for_fd(other_fd);

        insert_popup_policy_for_test(fd, "target", "test-window", 10, 10, 0, Some((0, 0)));
        let mut conn = WaylandConn::new();
        conn.surface_ids.insert(10, "test-window".into());
        CONNS.get().unwrap().lock().unwrap().insert(fd, conn);
        let mut last_buttons = LAST_BUTTON.get().unwrap().lock().unwrap();
        last_buttons.by_surface.insert(
            (fd, 10),
            LastButton {
                fd,
                seat_id: 1,
                serial: 2,
                wl_surface_id: 10,
                x: 3,
                y: 4,
                at: Instant::now(),
            },
        );
        last_buttons.latest = Some((fd, 10));
        drop(last_buttons);

        let cancelled = Arc::new(AtomicU32::new(0));
        let cancelled_by_cleanup = Arc::clone(&cancelled);
        let retained = Arc::new(AtomicU32::new(0));
        let retained_for_other_surface = Arc::clone(&retained);
        let mut axis_watchers = NEXT_POINTER_AXIS.get().unwrap().lock().unwrap();
        axis_watchers.insert(
            (fd, 10),
            vec![PointerAxisWatcher {
                token: 2,
                callback: Box::new(move |axis| {
                    assert_eq!(axis, None);
                    cancelled_by_cleanup.fetch_add(1, Ordering::Relaxed);
                }),
            }],
        );
        axis_watchers.insert(
            (other_fd, 11),
            vec![PointerAxisWatcher {
                token: 3,
                callback: Box::new(move |axis| {
                    assert_eq!(axis, Some(1));
                    retained_for_other_surface.fetch_add(1, Ordering::Relaxed);
                }),
            }],
        );
        drop(axis_watchers);

        clear_runtime_state_for_fd(fd);
        assert_eq!(cancelled.load(Ordering::Relaxed), 1);
        assert!(popup_policy("target").is_none());
        // The window name lives in the connection's surface map, so per-fd
        // runtime cleanup leaves it alone: it dies with the surface (and the
        // connection), not with the runtime state.
        assert_eq!(window_surface("test-window"), Some((fd, 10)));
        let last_buttons = LAST_BUTTON.get().unwrap().lock().unwrap();
        assert!(
            last_buttons
                .by_surface
                .keys()
                .all(|(button_fd, _)| *button_fd != fd)
        );
        assert!(
            last_buttons
                .latest
                .is_none_or(|(button_fd, _)| button_fd != fd)
        );
        drop(last_buttons);

        fire_next_pointer_axis(other_fd, 11, 1);
        assert_eq!(retained.load(Ordering::Relaxed), 1);

        // The name is connection-scoped, so it goes away with the connection.
        on_close(fd);
        assert!(window_surface("test-window").is_none());
    }

    #[test]
    fn purging_surface_clears_pointer_focus_and_position() {
        let mut conn = WaylandConn::new();
        conn.ifaces.insert(10, Iface::WlSurface);
        conn.pointer_focus.insert(20, 10);
        conn.pointer_position.insert(20, (30, 40));

        conn.purge(10);

        assert!(!conn.pointer_focus.contains_key(&20));
        assert!(!conn.pointer_position.contains_key(&20));
    }
}
