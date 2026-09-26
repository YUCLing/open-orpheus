use std::{
    collections::{HashMap, HashSet, VecDeque},
    os::fd::RawFd,
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use super::codec::Iface;
use super::layer_shell::LayerShellOptions;

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
    pub(crate) pointer_seat: HashMap<u32, u32>,
    pub(crate) touch_seat: HashMap<u32, u32>,
    pub(crate) xdg_to_wl: HashMap<u32, u32>,
    pub(crate) wl_to_top: HashMap<u32, u32>,
    pub(crate) top_to_xdg: HashMap<u32, u32>,
    pub(crate) compositor_id: Option<u32>,
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
    pub(crate) wl_to_layer: HashMap<u32, u32>,
    pub(crate) xdg_to_layer: HashMap<u32, u32>,
    /// Messages the proxy owes the client, queued by a request handler and
    /// flushed on the next inbound chunk.
    pub(crate) pending_to_client: Vec<Vec<u8>>,
}

impl WaylandConn {
    pub(crate) fn new() -> Self {
        let mut ifaces = HashMap::new();
        ifaces.insert(1u32, Iface::WlDisplay);
        Self {
            ifaces,
            pointer_focus: HashMap::new(),
            pointer_seat: HashMap::new(),
            touch_seat: HashMap::new(),
            xdg_to_wl: HashMap::new(),
            wl_to_top: HashMap::new(),
            top_to_xdg: HashMap::new(),
            compositor_id: None,
            injected_ids: HashSet::new(),
            stolen_ids: Vec::new(),
            globals: HashMap::new(),
            registry_id: None,
            layer_shell_global: None,
            layer_shell_id: None,
            layer_windows: HashMap::new(),
            layer_surfaces: HashMap::new(),
            wl_to_layer: HashMap::new(),
            xdg_to_layer: HashMap::new(),
            pending_to_client: Vec::new(),
        }
    }

    pub(crate) fn reset_tracking(&mut self) {
        self.ifaces.clear();
        self.ifaces.insert(1u32, Iface::WlDisplay);
        self.pointer_focus.clear();
        self.pointer_seat.clear();
        self.touch_seat.clear();
        self.xdg_to_wl.clear();
        self.wl_to_top.clear();
        self.top_to_xdg.clear();
        self.compositor_id = None;
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
        self.wl_to_layer.clear();
        self.xdg_to_layer.clear();
        self.pending_to_client.clear();
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
                self.xdg_to_wl.retain(|_, v| *v != id);
                self.wl_to_top.remove(&id);
                self.pointer_focus.retain(|_, v| *v != id);
            }
            Some(Iface::XdgSurface) => {
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
            Some(Iface::XdgToplevel) => {
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
            _ => {}
        }
        self.ifaces.remove(&id);
    }

    pub(crate) fn wl_surface_for_window_object(&self, id: u32, iface: Iface) -> Option<u32> {
        match iface {
            Iface::WlSurface => Some(id),
            Iface::XdgSurface => self.xdg_to_wl.get(&id).copied(),
            Iface::XdgToplevel => self
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
#[allow(clippy::type_complexity)]
pub(crate) static LAST_BUTTON: OnceLock<Mutex<Option<(RawFd, u32, u32, u32)>>> = OnceLock::new();
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

/// Set once a compositor connection advertises `zwlr_layer_shell_v1`.
pub(crate) static LAYER_SHELL_AVAILABLE: AtomicBool = AtomicBool::new(false);

/// How long an unconsumed layer-shell declaration stays valid.
const LAYER_DECLARATION_TTL: Duration = Duration::from_secs(2);

/// Windows declared as layer surfaces before they exist, oldest first.
static PENDING_LAYER_WINDOWS: OnceLock<Mutex<VecDeque<(LayerShellOptions, Instant)>>> =
    OnceLock::new();

pub(crate) fn mark_layer_shell_available() {
    LAYER_SHELL_AVAILABLE.store(true, Ordering::Relaxed);
}

pub(crate) fn is_layer_shell_available() -> bool {
    LAYER_SHELL_AVAILABLE.load(Ordering::Relaxed)
}

/// Queue `options` for the next toplevel the client creates.
pub(crate) fn declare_layer_window(options: LayerShellOptions) -> bool {
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
    queue.push_back((options, Instant::now()));
    true
}

/// Drop the newest declaration that has not been consumed yet.
pub(crate) fn cancel_layer_window() -> bool {
    let Some(queue) = PENDING_LAYER_WINDOWS.get() else {
        return false;
    };
    let Ok(mut queue) = queue.lock() else {
        return false;
    };
    queue.pop_back().is_some()
}

/// Take the oldest live declaration, discarding stale ones.
pub(crate) fn take_layer_window_declaration() -> Option<LayerShellOptions> {
    let queue = PENDING_LAYER_WINDOWS.get()?;
    let Ok(mut queue) = queue.lock() else {
        return None;
    };
    let now = Instant::now();
    while let Some((options, declared_at)) = queue.pop_front() {
        if now.duration_since(declared_at) <= LAYER_DECLARATION_TTL {
            return Some(options);
        }
    }
    None
}

pub(crate) type CursorEnterCb = Box<dyn FnOnce(i32, i32) + Send>;
pub(crate) type CursorEnterWatcherKey = (RawFd, u32);
pub(crate) type CursorEnterWatcherMap = HashMap<CursorEnterWatcherKey, Vec<CursorEnterCb>>;
pub(crate) static NEXT_TOPLEVEL_CURSOR_ENTER: OnceLock<Mutex<Vec<CursorEnterCb>>> = OnceLock::new();
pub(crate) static CURSOR_ENTER_WATCHERS: OnceLock<Mutex<CursorEnterWatcherMap>> = OnceLock::new();

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
    let callbacks: Vec<_> = pending.drain(..).collect();
    drop(pending);
    if let Some(watchers) = CURSOR_ENTER_WATCHERS.get()
        && let Ok(mut watchers) = watchers.lock()
    {
        watchers
            .entry((fd, wl_surface_id))
            .or_default()
            .extend(callbacks);
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
    if let Some(callbacks) = callbacks {
        for callback in callbacks {
            callback(x, y);
        }
    }
}

pub(crate) fn clear_first_cursor_enter_watchers_for_fd(fd: RawFd) {
    if let Some(watchers) = CURSOR_ENTER_WATCHERS.get()
        && let Ok(mut watchers) = watchers.lock()
    {
        watchers.retain(|(watch_fd, _), _| *watch_fd != fd);
    }
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

pub(crate) fn on_close(fd: RawFd) {
    if let Some(m) = CONNS.get()
        && let Ok(mut map) = m.lock()
    {
        map.remove(&fd);
    }
    if let Some(m) = LAST_BUTTON.get()
        && let Ok(mut opt) = m.lock()
        && opt.is_some_and(|(f, _, _, _)| f == fd)
    {
        *opt = None;
    }
    if let Some(m) = RX_BUFS.get() {
        let _ = m.lock().map(|mut g| g.remove(&fd));
    }
    if let Some(m) = TX_BUFS.get() {
        let _ = m.lock().map(|mut g| g.remove(&fd));
    }
    if let Some(m) = RX_PENDING_CTRL.get()
        && let Ok(mut g) = m.lock()
        && let Some(pending) = g.remove(&fd)
    {
        close_pending_control(pending);
    }
    if let Some(m) = TX_PENDING_CTRL.get()
        && let Ok(mut g) = m.lock()
        && let Some(pending) = g.remove(&fd)
    {
        close_pending_control(pending);
    }
    if let Some(m) = CUSTOM_ID_MAP.get()
        && let Ok(mut map) = m.lock()
    {
        map.retain(|_, v| v.0 != fd);
    }
    clear_first_cursor_enter_watchers_for_fd(fd);
}

pub(crate) fn is_wayland() -> bool {
    *IS_WAYLAND.get().unwrap_or(&false)
}

pub(crate) fn init_state() {
    CONNS.get_or_init(|| Mutex::new(HashMap::new()));
    LAST_BUTTON.get_or_init(|| Mutex::new(None));
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
        && let Ok(mut opt) = m.lock()
    {
        *opt = None;
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
    if let Some(m) = NEXT_TOPLEVEL_CURSOR_ENTER.get()
        && let Ok(mut cbs) = m.lock()
    {
        cbs.clear();
    }
    if let Some(m) = CURSOR_ENTER_WATCHERS.get()
        && let Ok(mut watchers) = m.lock()
    {
        watchers.clear();
    }
    if let Some(m) = PENDING_LAYER_WINDOWS.get()
        && let Ok(mut queue) = m.lock()
    {
        queue.clear();
    }
    LAYER_SHELL_AVAILABLE.store(false, Ordering::Relaxed);
}
