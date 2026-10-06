use std::{
    collections::{HashMap, HashSet, VecDeque},
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
    pub(crate) registry_id: Option<u32>,
    /// The `zwlr_layer_shell_v1` global as (global name, advertised version).
    pub(crate) layer_shell_global: Option<(u32, u32)>,
    /// The shell object the proxy bound for itself, once it was first needed.
    pub(crate) layer_shell_id: Option<u32>,
    /// Converted windows, keyed by the id the client uses for its toplevel.
    pub(crate) layer_windows: HashMap<u32, LayerWindow>,
    /// Surfaces that have taken the layer role, with the declaration that put
    /// them there.
    ///
    /// The compositor keeps the role on the `wl_surface` after the role object
    /// is gone (KWin answers a later `get_toplevel` on that surface with
    /// `already_constructed`), so this outlives the window: a surface that asks
    /// for a toplevel again has to be converted again. It is dropped with the
    /// surface, so a genuinely new surface starts out ordinary.
    pub(crate) layer_surfaces: HashMap<u32, LayerShellOptions>,
    /// Surfaces that have been given the ordinary `xdg_toplevel` role.
    ///
    /// A compositor never releases a surface's role while the surface lives,
    /// and unlike the layer role this one cannot be replaced by a layer surface:
    /// asking is a fatal protocol error (`the wl_surface already has a role
    /// assigned xdg_toplevel`). Remembered for the life of the surface so the
    /// proxy can refuse instead of killing the connection.
    pub(crate) toplevel_surfaces: HashSet<u32>,
    /// The managed window id each surface belongs to, for the life of the
    /// surface.
    ///
    /// `CUSTOM_ID_MAP` is what the application looks windows up by, and it is
    /// cleared as soon as any object of the surface is destroyed — which is
    /// exactly when a window asks for a role it cannot have: the old toplevel
    /// is gone and the new one has no title yet. This keeps the name available
    /// for that report, and dies with the surface itself.
    pub(crate) surface_ids: HashMap<u32, String>,
    pub(crate) wl_to_layer: HashMap<u32, u32>,
    pub(crate) xdg_to_layer: HashMap<u32, u32>,
    /// Messages the proxy owes the client, queued by a request handler and
    /// flushed on the next inbound chunk.
    pub(crate) pending_to_client: Vec<Vec<u8>>,
    pub(crate) deferred_role: Option<super::handlers::roles::DeferredRole>,
    pub(crate) role_window_id: Option<String>,
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
            registry_id: None,
            layer_shell_global: None,
            layer_shell_id: None,
            layer_windows: HashMap::new(),
            layer_surfaces: HashMap::new(),
            toplevel_surfaces: HashSet::new(),
            surface_ids: HashMap::new(),
            wl_to_layer: HashMap::new(),
            xdg_to_layer: HashMap::new(),
            pending_to_client: Vec::new(),
            deferred_role: None,
            role_window_id: None,
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
        self.registry_id = None;
        self.layer_shell_global = None;
        // The layer shell object belongs to the client namespace, so it has to
        // be re-bound after a resync.
        self.layer_shell_id = None;
        self.layer_windows.clear();
        self.layer_surfaces.clear();
        self.toplevel_surfaces.clear();
        self.surface_ids.clear();
        self.wl_to_layer.clear();
        self.xdg_to_layer.clear();
        self.pending_to_client.clear();
        self.deferred_role = None;
        self.role_window_id = None;
    }

    pub(crate) fn alloc_injected_id(&mut self) -> Option<u32> {
        let id = self.stolen_ids.pop()?;
        self.injected_ids.insert(id);
        Some(id)
    }

    pub(crate) fn purge(&mut self, id: u32) {
        match self.ifaces.get(&id).copied() {
            Some(Iface::WlPointer) => {
                self.pointer_focus.remove(&id);
                self.pointer_position.remove(&id);
                self.pointer_seat.remove(&id);
            }
            Some(Iface::WlTouch) => {
                self.touch_seat.remove(&id);
            }
            Some(Iface::WlSurface) => {
                if let Some(layer_id) = self.wl_to_layer.remove(&id) {
                    self.purge(layer_id);
                }
                // The role dies with the surface it was assigned to.
                self.layer_surfaces.remove(&id);
                self.toplevel_surfaces.remove(&id);
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
    use super::*;

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

        conn.reset_tracking();

        assert_eq!(conn.ifaces.len(), 1);
        assert!(conn.stolen_ids.is_empty());
        assert!(conn.injected_ids.is_empty());
        assert!(conn.top_to_xdg.is_empty());
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
}

#[derive(Default)]
pub(crate) struct LastButtonState {
    pub(crate) by_surface: HashMap<(RawFd, u32), LastButton>,
    pub(crate) latest: Option<(RawFd, u32)>,
}

pub(crate) struct PendingPopup {
    pub(crate) token: u32,
    pub(crate) parent_xdg_surface_id: u32,
    pub(crate) width: i32,
    pub(crate) height: i32,
    pub(crate) shadow_inset: i32,
    pub(crate) anchor_x: i32,
    pub(crate) anchor_y: i32,
    pub(crate) positioner_id: u32,
    pub(crate) target_window_id: String,
}

pub(crate) static LAST_BUTTON: OnceLock<Mutex<LastButtonState>> = OnceLock::new();
pub(crate) static PENDING_POPUPS: OnceLock<Mutex<HashMap<RawFd, PendingPopup>>> = OnceLock::new();
static NEXT_POPUP_TOKEN: AtomicU32 = AtomicU32::new(1);
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

// Custom window ID map tracking user-assigned IDs via setTitle("\u{200B}\u{200C}<id>")
pub(crate) static CUSTOM_ID_MAP: OnceLock<Mutex<HashMap<String, (RawFd, u32)>>> = OnceLock::new();

// ── Layer shell ────────────────────────────────────────────────────────────

/// How long an unconsumed layer-shell declaration stays valid.
const LAYER_DECLARATION_TTL: Duration = Duration::from_secs(2);

/// Windows declared as layer surfaces before they exist, oldest first.
type LayerDeclaration = (LayerShellOptions, Instant, Option<String>);
static PENDING_LAYER_WINDOWS: OnceLock<Mutex<VecDeque<LayerDeclaration>>> = OnceLock::new();

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

/// Test shorthand for queuing an unnamed layer-shell declaration.
#[cfg(test)]
pub(crate) fn declare_layer_window(options: LayerShellOptions) -> bool {
    declare_named_layer_window(options, None)
}

/// Queue `options` before a window's role is created.
///
/// Named declarations belong to one managed window and replace its previous
/// pending declaration. Unnamed declarations retain the positional behaviour.
pub(crate) fn declare_named_layer_window(
    options: LayerShellOptions,
    owner: Option<String>,
) -> bool {
    // Saying nothing about size or anchors means "cover the output"; only
    // combinations that cannot be sent are refused.
    let options = options.with_defaults();
    if options.validate().is_err() {
        return false;
    }
    let Some(queue) = PENDING_LAYER_WINDOWS.get() else {
        return false;
    };
    let Ok(mut queue) = queue.lock() else {
        return false;
    };
    if let Some(owner) = &owner {
        queue.retain(|(_, _, existing)| existing.as_ref() != Some(owner));
    }
    queue.push_back((options, Instant::now(), owner));
    true
}

/// Test shorthand for cancelling the newest unnamed declaration.
#[cfg(test)]
pub(crate) fn cancel_layer_window() -> bool {
    cancel_named_layer_window(None)
}

/// Drop the newest unconsumed declaration for `owner`, or the newest unnamed
/// declaration when no owner is provided.
pub(crate) fn cancel_named_layer_window(owner: Option<&str>) -> bool {
    let Some(queue) = PENDING_LAYER_WINDOWS.get() else {
        return false;
    };
    let Ok(mut queue) = queue.lock() else {
        return false;
    };
    let index = queue
        .iter()
        .rposition(|(_, _, existing)| existing.as_deref() == owner);
    index.is_some_and(|index| queue.remove(index).is_some())
}

/// Test shorthand for consuming the oldest live unnamed declaration.
#[cfg(test)]
pub(crate) fn take_layer_window_declaration() -> Option<LayerShellOptions> {
    take_named_layer_window_declaration(None)
}

/// Discard stale declarations and consume the oldest matching owner first,
/// falling back to the oldest unnamed declaration without taking another owner.
pub(crate) fn take_named_layer_window_declaration(
    owner: Option<&str>,
) -> Option<LayerShellOptions> {
    let queue = PENDING_LAYER_WINDOWS.get()?;
    let Ok(mut queue) = queue.lock() else {
        return None;
    };
    let now = Instant::now();
    queue.retain(|(_, declared_at, _)| now.duration_since(*declared_at) <= LAYER_DECLARATION_TTL);
    let index = owner
        .and_then(|owner| {
            queue
                .iter()
                .position(|(_, _, existing)| existing.as_deref() == Some(owner))
        })
        .or_else(|| queue.iter().position(|(_, _, existing)| existing.is_none()))?;
    queue.remove(index).map(|(options, _, _)| options)
}

pub(crate) fn has_named_role_pending(fd: RawFd) -> bool {
    PENDING_POPUPS
        .get()
        .and_then(|pending| pending.lock().ok())
        .is_some_and(|pending| pending.contains_key(&fd))
        || PENDING_LAYER_WINDOWS
            .get()
            .and_then(|queue| queue.lock().ok())
            .is_some_and(|queue| {
                queue
                    .iter()
                    .any(|(_, at, owner)| owner.is_some() && at.elapsed() <= LAYER_DECLARATION_TTL)
            })
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

#[cfg(test)]
pub(crate) fn arm_next_popup(
    parent_window_id: &str,
    target_window_id: &str,
    width: i32,
    height: i32,
    anchor: Option<(i32, i32)>,
) -> Option<u32> {
    arm_next_popup_with_inset(parent_window_id, target_window_id, width, height, anchor, 0)
}

pub(crate) fn arm_next_popup_with_inset(
    parent_window_id: &str,
    target_window_id: &str,
    width: i32,
    height: i32,
    anchor: Option<(i32, i32)>,
    shadow_inset: i32,
) -> Option<u32> {
    if width <= 0 || height <= 0 || width > MAX_POPUP_DIMENSION || height > MAX_POPUP_DIMENSION {
        return None;
    }
    if shadow_inset < 0 || shadow_inset > (width.min(height) - 1) / 2 {
        return None;
    }
    // Match the filter's lock order: CONNS, then window mapping/pending state.
    // Keep the connection alive through allocation AND publication so close
    // cannot leave a pending request on a reused descriptor.
    let mut conns = CONNS.get()?.lock().ok()?;
    let parent_mapping = CUSTOM_ID_MAP
        .get()
        .and_then(|map| map.lock().ok()?.get(parent_window_id).copied());
    let (fd, parent_wl_surface_id) = parent_mapping?;
    if let Some((target_fd, target_surface)) = CUSTOM_ID_MAP
        .get()
        .and_then(|map| map.lock().ok()?.get(target_window_id).copied())
    {
        let target_conn = conns.get(&target_fd)?;
        // Some compositors create the hidden window's role before show. That
        // role is permanent: refuse before the caller shows an ordinary
        // toplevel, instead of showing it and then replacing it with overlay.
        if target_fd != fd
            || target_conn
                .surface_ids
                .get(&target_surface)
                .map(String::as_str)
                != Some(target_window_id)
            || target_conn.wl_to_top.contains_key(&target_surface)
            || target_conn.layer_surfaces.contains_key(&target_surface)
        {
            return None;
        }
    }
    let conn = conns.get_mut(&fd)?;
    // A layer surface cannot be used as xdg_popup's xdg parent. Leave these
    // windows on the existing overlay path instead of sending an invalid role.
    if conn.layer_surfaces.contains_key(&parent_wl_surface_id) {
        return None;
    }
    if conn
        .surface_ids
        .get(&parent_wl_surface_id)
        .map(String::as_str)
        != Some(parent_window_id)
    {
        return None;
    }
    let parent_xdg_surface_id = conn
        .xdg_to_wl
        .iter()
        .find_map(|(xdg, wl)| (*wl == parent_wl_surface_id).then_some(*xdg))?;

    let (anchor_x, anchor_y) = if let Some((x, y)) = anchor {
        (x, y)
    } else {
        let button = LAST_BUTTON
            .get()
            .and_then(|v| v.lock().ok())
            .and_then(|v| v.by_surface.get(&(fd, parent_wl_surface_id)).copied());
        let button = button?;
        (button.x, button.y)
    };

    let mut pending = PENDING_POPUPS.get()?.lock().ok()?;
    if pending.contains_key(&fd) {
        return None;
    }
    let positioner_id = conn.alloc_injected_id()?;
    let token = next_unused_token(&NEXT_POPUP_TOKEN, |candidate| {
        pending.values().any(|popup| popup.token == candidate)
    });
    pending.insert(
        fd,
        PendingPopup {
            token,
            parent_xdg_surface_id,
            width,
            height,
            shadow_inset,
            anchor_x,
            anchor_y,
            positioner_id,
            target_window_id: target_window_id.into(),
        },
    );
    Some(token)
}

pub(crate) fn window_is_popup(window_id: &str) -> bool {
    let Some((fd, wl_surface_id)) = CUSTOM_ID_MAP
        .get()
        .and_then(|map| map.lock().ok()?.get(window_id).copied())
    else {
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

pub(crate) fn cancel_pending_popup(token: u32) -> bool {
    // Allocation, cancellation and close all use CONNS -> PENDING_POPUPS.
    let Some(conns) = CONNS.get() else {
        return false;
    };
    let Ok(mut conns) = conns.lock() else {
        return false;
    };
    let Some(pending) = PENDING_POPUPS.get() else {
        return false;
    };
    let (fd, popup) = {
        let Ok(mut pending) = pending.lock() else {
            return false;
        };
        let Some(fd) = pending
            .iter()
            .find_map(|(fd, popup)| (popup.token == token).then_some(*fd))
        else {
            return false;
        };
        let Some(popup) = pending.remove(&fd) else {
            return false;
        };
        (fd, popup)
    };
    if let Some(conn) = conns.get_mut(&fd)
        && conn.injected_ids.remove(&popup.positioner_id)
    {
        conn.stolen_ids.push(popup.positioner_id);
    }
    true
}

pub(crate) fn take_pending_popup(fd: RawFd, target_window_id: &str) -> Option<PendingPopup> {
    let mut pending = PENDING_POPUPS.get()?.lock().ok()?;
    if pending
        .get(&fd)
        .is_some_and(|popup| popup.target_window_id == target_window_id)
    {
        pending.remove(&fd)
    } else {
        None
    }
}

pub(crate) fn cancel_pending_popup_for_parent(
    fd: RawFd,
    parent_xdg_surface_id: u32,
    conn: &mut WaylandConn,
) {
    let popup = PENDING_POPUPS.get().and_then(|pending| {
        let mut pending = pending.lock().ok()?;
        if pending
            .get(&fd)
            .is_some_and(|popup| popup.parent_xdg_surface_id == parent_xdg_surface_id)
        {
            pending.remove(&fd)
        } else {
            None
        }
    });
    if let Some(popup) = popup
        && conn.injected_ids.remove(&popup.positioner_id)
    {
        conn.stolen_ids.push(popup.positioner_id);
    }
}

pub(crate) fn cancel_pending_popup_for_connection(fd: RawFd, conn: &mut WaylandConn) {
    let popup = PENDING_POPUPS
        .get()
        .and_then(|pending| pending.lock().ok()?.remove(&fd));
    if let Some(popup) = popup
        && conn.injected_ids.remove(&popup.positioner_id)
    {
        conn.stolen_ids.push(popup.positioner_id);
    }
}

pub(crate) fn watch_next_pointer_axis(window_id: &str, callback: PointerAxisCb) -> Option<u32> {
    let registration = (|| {
        let conns = CONNS.get()?.lock().ok()?;
        let (fd, wl_surface_id) = CUSTOM_ID_MAP
            .get()
            .and_then(|map| map.lock().ok()?.get(window_id).copied())?;
        let conn = conns.get(&fd)?;
        if conn.surface_ids.get(&wl_surface_id).map(String::as_str) != Some(window_id) {
            return None;
        }
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
    if let Some(m) = CUSTOM_ID_MAP.get()
        && let Ok(mut map) = m.lock()
    {
        map.retain(|_, value| value.0 != fd);
    }
    let pending_popup = PENDING_POPUPS
        .get()
        .and_then(|pending| pending.lock().ok()?.remove(&fd));
    if let Some(popup) = pending_popup
        && let Some(conns) = CONNS.get()
        && let Ok(mut conns) = conns.lock()
        && let Some(conn) = conns.get_mut(&fd)
        && conn.injected_ids.remove(&popup.positioner_id)
    {
        conn.stolen_ids.push(popup.positioner_id);
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
        if let Some(pending) = PENDING_POPUPS.get()
            && let Ok(mut pending) = pending.lock()
        {
            pending.remove(&fd);
        }
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
    PENDING_POPUPS.get_or_init(|| Mutex::new(HashMap::new()));
    NEXT_POINTER_AXIS.get_or_init(|| Mutex::new(HashMap::new()));
    CUSTOM_ID_MAP.get_or_init(|| Mutex::new(HashMap::new()));
    RX_BUFS.get_or_init(|| Mutex::new(HashMap::new()));
    TX_BUFS.get_or_init(|| Mutex::new(HashMap::new()));
    RX_PENDING_CTRL.get_or_init(|| Mutex::new(HashMap::new()));
    TX_PENDING_CTRL.get_or_init(|| Mutex::new(HashMap::new()));
    NEXT_TOPLEVEL_CURSOR_ENTER.get_or_init(|| Mutex::new(Vec::new()));
    CURSOR_ENTER_WATCHERS.get_or_init(|| Mutex::new(HashMap::new()));
    PENDING_LAYER_WINDOWS.get_or_init(|| Mutex::new(VecDeque::new()));
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
    if let Some(m) = PENDING_POPUPS.get()
        && let Ok(mut pending) = m.lock()
    {
        pending.clear();
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
    if let Some(m) = CUSTOM_ID_MAP.get()
        && let Ok(mut map) = m.lock()
    {
        map.clear();
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
    if let Some(m) = PENDING_LAYER_WINDOWS.get()
        && let Ok(mut queue) = m.lock()
    {
        queue.clear();
    }
}

#[cfg(test)]
mod popup_tests {
    use std::sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    };

    use super::*;

    // These interleavings observe the same global connection lock. Serialize
    // them, like the injection fixtures, so one race cannot satisfy another's
    // "connection locked" checkpoint before its worker has reached it.
    static CONNECTION_RACES: Mutex<()> = Mutex::new(());

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
    fn cancellation_holds_connection_until_reserved_id_is_recycled() {
        let _guard = CONNECTION_RACES.lock().unwrap();
        init_state();
        let fd = 93_601;
        let mut conn = WaylandConn::new();
        conn.injected_ids.insert(900);
        CONNS.get().unwrap().lock().unwrap().insert(fd, conn);
        PENDING_POPUPS.get().unwrap().lock().unwrap().insert(
            fd,
            PendingPopup {
                token: fd as u32,
                parent_xdg_surface_id: 20,
                width: 100,
                height: 80,
                shadow_inset: 0,
                anchor_x: 0,
                anchor_y: 0,
                positioner_id: 900,
                target_window_id: "target".into(),
            },
        );
        let pending = PENDING_POPUPS.get().unwrap().lock().unwrap();
        let cancelling = std::thread::spawn(move || cancel_pending_popup(fd as u32));
        wait_for_connection_lock();
        let closing = std::thread::spawn(move || on_close(fd));
        drop(pending);
        assert!(cancelling.join().unwrap());
        closing.join().unwrap();
        let mut replacement = WaylandConn::new();
        replacement.injected_ids.insert(900);
        CONNS.get().unwrap().lock().unwrap().insert(fd, replacement);
        assert!(!cancel_pending_popup(fd as u32));
        assert!(
            CONNS
                .get()
                .unwrap()
                .lock()
                .unwrap()
                .get(&fd)
                .unwrap()
                .injected_ids
                .contains(&900)
        );
        on_close(fd);
    }

    #[test]
    fn axis_registration_is_atomic_with_close_and_rejects_stale_identity() {
        let _guard = CONNECTION_RACES.lock().unwrap();
        init_state();
        let fd = 93_602;
        let mut conn = WaylandConn::new();
        conn.surface_ids.insert(10, "axis-owner".into());
        CONNS.get().unwrap().lock().unwrap().insert(fd, conn);
        CUSTOM_ID_MAP
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .insert("axis-owner".into(), (fd, 10));
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
        CUSTOM_ID_MAP
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .insert("axis-owner".into(), (fd, 10));
        assert!(
            watch_next_pointer_axis("axis-owner", Box::new(|axis| assert!(axis.is_none())))
                .is_none()
        );
        on_close(fd);
    }

    #[test]
    fn popup_publication_is_atomic_with_close_and_fd_reuse() {
        use std::sync::{TryLockError, mpsc};
        use std::thread;

        let _guard = CONNECTION_RACES.lock().unwrap();

        init_state();
        let fd = 93_001;
        let window_id = "popup-close-race";
        let mut conn = WaylandConn::new();
        conn.xdg_to_wl.insert(20, 10);
        conn.surface_ids.insert(10, window_id.into());
        conn.stolen_ids.push(900);
        CONNS.get().unwrap().lock().unwrap().insert(fd, conn);
        CUSTOM_ID_MAP
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .insert(window_id.into(), (fd, 10));

        // Stop publication at the pending lock. Arming must retain CONNS while
        // blocked here; close must not pass it and remove the old connection.
        let pending = PENDING_POPUPS.get().unwrap().lock().unwrap();
        let arming =
            thread::spawn(move || arm_next_popup(window_id, "target", 100, 80, Some((4, 5))));
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match CONNS.get().unwrap().try_lock() {
                Err(TryLockError::WouldBlock) => break,
                Err(TryLockError::Poisoned(_)) => panic!("poisoned connection map"),
                Ok(guard) => drop(guard),
            }
            assert!(Instant::now() < deadline, "arming did not acquire CONNS");
            thread::yield_now();
        }
        let (started_tx, started_rx) = mpsc::channel();
        let (closed_tx, closed_rx) = mpsc::channel();
        let closing = thread::spawn(move || {
            started_tx.send(()).unwrap();
            on_close(fd);
            closed_tx.send(()).unwrap();
        });
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(matches!(
            closed_rx.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        drop(pending);
        assert!(arming.join().unwrap().is_some());
        closed_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        closing.join().unwrap();

        // The descriptor can now be reused, but not the pending positioner.
        CONNS
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .insert(fd, WaylandConn::new());
        assert!(take_pending_popup(fd, "target").is_none());
        assert!(arm_next_popup(window_id, "target", 100, 80, Some((4, 5))).is_none());
        on_close(fd);
    }

    #[test]
    fn an_already_assigned_target_role_cannot_reserve_a_popup() {
        let _guard = CONNECTION_RACES.lock().unwrap();
        init_state();
        let fd = 93_005;
        let parent_id = "popup-assigned-parent";
        let target_id = "popup-assigned-target";
        let mut conn = WaylandConn::new();
        conn.surface_ids.insert(10, parent_id.into());
        conn.surface_ids.insert(11, target_id.into());
        conn.xdg_to_wl.insert(20, 10);
        conn.xdg_to_wl.insert(21, 11);
        conn.wl_to_top.insert(11, 31);
        conn.top_to_xdg.insert(31, 21);
        conn.ifaces.insert(31, Iface::XdgToplevel);
        conn.stolen_ids.push(900);
        CONNS.get().unwrap().lock().unwrap().insert(fd, conn);
        {
            let mut map = CUSTOM_ID_MAP.get().unwrap().lock().unwrap();
            map.insert(parent_id.into(), (fd, 10));
            map.insert(target_id.into(), (fd, 11));
        }
        assert!(arm_next_popup(parent_id, target_id, 100, 80, Some((4, 5))).is_none());
        assert!(take_pending_popup(fd, target_id).is_none());
        {
            let conns = CONNS.get().unwrap().lock().unwrap();
            let conn = conns.get(&fd).unwrap();
            assert_eq!(conn.stolen_ids, vec![900]);
            assert_eq!(conn.ifaces.get(&31), Some(&Iface::XdgToplevel));
        }
        on_close(fd);
    }

    #[test]
    fn popup_reservation_requires_parent_anchor_and_object_id_data() {
        let _guard = CONNECTION_RACES.lock().unwrap();
        init_state();
        let fd = 93_004;
        let window_id = "popup-data-readiness";
        let mut conn = WaylandConn::new();
        conn.surface_ids.insert(10, window_id.into());
        CONNS.get().unwrap().lock().unwrap().insert(fd, conn);
        CUSTOM_ID_MAP
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .insert(window_id.into(), (fd, 10));

        // A tracked window alone is not enough: it needs an xdg parent.
        assert!(arm_next_popup(window_id, "target", 100, 80, Some((4, 5))).is_none());
        CONNS
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .get_mut(&fd)
            .unwrap()
            .xdg_to_wl
            .insert(20, 10);
        // Missing pointer data or a compositor-released ID also leaves the
        // request unarmed, so the caller can fall back without showing it.
        assert!(arm_next_popup(window_id, "target", 100, 80, None).is_none());
        assert!(arm_next_popup(window_id, "target", 100, 80, Some((4, 5))).is_none());
        assert!(take_pending_popup(fd, "target").is_none());
        CONNS
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .get_mut(&fd)
            .unwrap()
            .stolen_ids
            .push(900);
        let token = arm_next_popup(window_id, "target", 100, 80, Some((4, 5))).unwrap();
        assert_eq!(take_pending_popup(fd, "target").unwrap().token, token);
        assert!(take_pending_popup(fd, "target").is_none());
        on_close(fd);
    }

    #[test]
    fn stale_window_mapping_does_not_allocate_on_reused_fd() {
        init_state();
        let fd = 93_002;
        let mut replacement = WaylandConn::new();
        replacement.xdg_to_wl.insert(20, 10);
        replacement.surface_ids.insert(10, "new-window".into());
        replacement.stolen_ids.push(901);
        CONNS.get().unwrap().lock().unwrap().insert(fd, replacement);
        CUSTOM_ID_MAP
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .insert("old-window".into(), (fd, 10));
        assert!(arm_next_popup("old-window", "target", 100, 80, Some((0, 0))).is_none());
        assert_eq!(
            CONNS
                .get()
                .unwrap()
                .lock()
                .unwrap()
                .get(&fd)
                .unwrap()
                .stolen_ids,
            vec![901]
        );
        on_close(fd);
    }

    #[test]
    fn token_allocation_skips_zero_and_live_tokens_after_wrap() {
        let counter = AtomicU32::new(u32::MAX);
        let token = next_unused_token(&counter, |candidate| candidate == u32::MAX);
        assert_eq!(token, 1);
    }

    #[test]
    fn popup_reservation_only_accepts_its_managed_window() {
        init_state();
        let fd = 93_501;
        clear_runtime_state_for_fd(fd);
        PENDING_POPUPS.get().unwrap().lock().unwrap().insert(
            fd,
            PendingPopup {
                token: 7,
                parent_xdg_surface_id: 20,
                width: 100,
                height: 80,
                shadow_inset: 0,
                anchor_x: 4,
                anchor_y: 5,
                positioner_id: 30,
                target_window_id: "target".into(),
            },
        );
        assert!(take_pending_popup(fd, "old-window").is_none());
        assert!(take_pending_popup(fd, "unrelated-new-window").is_none());
        assert_eq!(take_pending_popup(fd, "target").unwrap().token, 7);
        assert!(take_pending_popup(fd, "target").is_none());
        clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn runtime_state_cleanup_is_connection_and_surface_scoped() {
        init_state();
        let fd = 91_001;
        let other_fd = 91_002;
        clear_runtime_state_for_fd(fd);
        clear_runtime_state_for_fd(other_fd);

        PENDING_POPUPS.get().unwrap().lock().unwrap().insert(
            fd,
            PendingPopup {
                token: 1,
                parent_xdg_surface_id: 20,
                width: 10,
                height: 10,
                shadow_inset: 0,
                anchor_x: 0,
                anchor_y: 0,
                positioner_id: 30,
                target_window_id: "target".into(),
            },
        );
        CUSTOM_ID_MAP
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .insert("test-window".into(), (fd, 10));
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
        assert!(
            !PENDING_POPUPS
                .get()
                .unwrap()
                .lock()
                .unwrap()
                .contains_key(&fd)
        );
        assert!(
            !CUSTOM_ID_MAP
                .get()
                .unwrap()
                .lock()
                .unwrap()
                .contains_key("test-window")
        );
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

        fire_next_pointer_axis(other_fd, 11, 1);
        assert_eq!(retained.load(Ordering::Relaxed), 1);
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

    #[test]
    fn cancelling_parent_popup_recycles_reserved_id() {
        init_state();
        let fd = 92_001;
        clear_runtime_state_for_fd(fd);
        let mut conn = WaylandConn::new();
        conn.injected_ids.insert(40);
        PENDING_POPUPS.get().unwrap().lock().unwrap().insert(
            fd,
            PendingPopup {
                token: 4,
                parent_xdg_surface_id: 21,
                width: 10,
                height: 10,
                shadow_inset: 0,
                anchor_x: 0,
                anchor_y: 0,
                positioner_id: 40,
                target_window_id: "target".into(),
            },
        );

        cancel_pending_popup_for_parent(fd, 21, &mut conn);

        assert!(
            !PENDING_POPUPS
                .get()
                .unwrap()
                .lock()
                .unwrap()
                .contains_key(&fd)
        );
        assert!(!conn.injected_ids.contains(&40));
        assert_eq!(conn.stolen_ids, vec![40]);
    }
}
