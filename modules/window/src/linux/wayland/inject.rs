use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};

use crate::linux::Rect;

use super::super::proxy::sink_for;
use super::codec::*;
use super::state::*;

/// `wl_compositor.create_region(new_id)`.
fn create_region_request(compositor_id: u32, region_id: u32) -> Vec<u8> {
    let mut buf = Vec::with_capacity(12);
    buf.extend_from_slice(&compositor_id.to_ne_bytes());
    buf.extend_from_slice(&((REQ_CREATE_REGION as u32) | (12u32 << 16)).to_ne_bytes());
    buf.extend_from_slice(&region_id.to_ne_bytes());
    buf
}

/// `wl_region.add(x, y, w, h)`.
fn region_add_request(region_id: u32, rect: &Rect) -> Vec<u8> {
    let mut buf = Vec::with_capacity(24);
    buf.extend_from_slice(&region_id.to_ne_bytes());
    buf.extend_from_slice(&((REQ_REGION_ADD as u32) | (24u32 << 16)).to_ne_bytes());
    buf.extend_from_slice(&rect.x.to_ne_bytes());
    buf.extend_from_slice(&rect.y.to_ne_bytes());
    buf.extend_from_slice(&rect.w.to_ne_bytes());
    buf.extend_from_slice(&rect.h.to_ne_bytes());
    buf
}

/// `wl_surface.set_input_region(region)`; region `0` is the empty region, which
/// needs no object and is how a click-through window is expressed.
fn set_input_region_request(wl_surface_id: u32, region_id: u32) -> Vec<u8> {
    let mut buf = Vec::with_capacity(12);
    buf.extend_from_slice(&wl_surface_id.to_ne_bytes());
    buf.extend_from_slice(&((REQ_SET_INPUT_REGION as u32) | (12u32 << 16)).to_ne_bytes());
    buf.extend_from_slice(&region_id.to_ne_bytes());
    buf
}

/// `wl_region.destroy()`.
fn destroy_region_request(region_id: u32) -> Vec<u8> {
    let mut buf = Vec::with_capacity(8);
    buf.extend_from_slice(&region_id.to_ne_bytes());
    buf.extend_from_slice(&((REQ_REGION_DESTROY as u32) | (8u32 << 16)).to_ne_bytes());
    buf
}

/// Build the requests that give `wl_surface_id` a region, in wire order.
///
/// `None` when the region object cannot be created for want of a recycled
/// object id; the caller keeps the record pending so a later commit tries again.
fn build_region_requests(
    conn: &mut WaylandConn,
    wl_surface_id: u32,
    rects: Option<&[Rect]>,
) -> Option<Vec<Vec<u8>>> {
    let mut requests = Vec::new();
    let mut region_id = 0;

    if let Some(rects) = rects {
        let compositor_id = conn.compositor_id?;
        region_id = conn.alloc_injected_id()?;
        requests.push(create_region_request(compositor_id, region_id));
        for rect in rects {
            requests.push(region_add_request(region_id, rect));
        }
    }

    // The surface takes the region before the object is released; the compositor
    // keeps its own reference.
    requests.push(set_input_region_request(wl_surface_id, region_id));
    if region_id != 0 {
        requests.push(destroy_region_request(region_id));
    }
    Some(requests)
}

/// The requests that put `window_id`'s recorded region on `wl_surface_id`, or
/// `None` when it has nothing pending.
///
/// Called while dispatching the client's `commit`, so the requests are emitted
/// immediately before it: a `set_input_region` is only adopted by the
/// compositor at the commit that follows it, and emitting it afterwards would
/// leave the window on its previous region until something committed again.
/// Returning the bytes rather than sending them keeps the proxy from writing
/// into the connection while the application thread might be blocked on a full
/// socketpair.
pub(super) fn region_requests_for_commit(
    conn: &mut WaylandConn,
    wl_surface_id: u32,
) -> Option<Vec<Vec<u8>>> {
    let window_id = conn.surface_ids.get(&wl_surface_id)?.clone();

    // The application thread stores regions; this thread reads and clears the
    // pending one. Holding the lock across both keeps a store from landing in
    // between and being forgotten.
    let _guard = INPUT_REGION_LOCK.lock().ok()?;

    let mut regions = recorded_input_regions().lock().ok()?;
    let region = regions.get_mut(&window_id)?;
    if !region.pending {
        return None;
    }

    let requests = build_region_requests(conn, wl_surface_id, region.rects.as_deref())?;
    region.pending = false;
    Some(requests)
}

/// Mark a window's recorded region as needing a send, so its surface's next
/// `commit` carries it.
///
/// The id is attached to its surface at the decorated title; a surface that is
/// re-created for the same window (an on-demand window being shown again) is a
/// new surface, so it needs the region again.
pub(super) fn mark_region_pending(window_id: &str) {
    if let Ok(_guard) = INPUT_REGION_LOCK.lock()
        && let Ok(mut regions) = recorded_input_regions().lock()
        && let Some(region) = regions.get_mut(window_id)
    {
        region.pending = true;
    }
}

/// What the proxy remembers for a window's input region.
struct RecordedRegion {
    /// `None` is an explicitly empty region — a fully click-through window.
    rects: Option<Vec<Rect>>,
    /// The region still has to be emitted before a commit on the window's
    /// surface. Cleared only once its requests have been placed on the wire, so
    /// a region that could not be built is not mistaken for an applied one.
    pending: bool,
}

/// The input region each managed window asked for, keyed by window id.
///
/// Recorded even when the surface is not known yet, so it can be applied when
/// the decorated title associates the id with a surface. An absent key means
/// the window never asked for one.
static RECORDED_INPUT_REGIONS: OnceLock<Mutex<HashMap<String, RecordedRegion>>> = OnceLock::new();

/// Serializes reading and clearing a recorded region against storing one.
///
/// The proxy thread drains a pending region while dispatching a commit, and the
/// application thread can store a new one at the same time. Without this, the
/// drain could emit an older region after the application had stored a newer
/// one. It is held only across in-memory work — no write, and no wait on the
/// connection — and the registry lock is only ever taken inside it.
static INPUT_REGION_LOCK: Mutex<()> = Mutex::new(());

fn recorded_input_regions() -> &'static Mutex<HashMap<String, RecordedRegion>> {
    RECORDED_INPUT_REGIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Record a window's input region.
///
/// Nothing is sent here: the region is emitted immediately before the next
/// `commit` on the window's surface, because that commit is what makes the
/// compositor adopt it. The caller is told "recorded", not "already in effect".
pub(super) fn set_input_region_rects(window_id: &str, rects: Option<&[Rect]>) -> bool {
    let Ok(_guard) = INPUT_REGION_LOCK.lock() else {
        return false;
    };
    let Ok(mut regions) = recorded_input_regions().lock() else {
        return false;
    };
    regions.insert(
        window_id.to_string(),
        RecordedRegion {
            rects: rects.map(|rects| rects.to_vec()),
            pending: true,
        },
    );
    true
}

/// Forget the region recorded for a window that will not come back.
///
/// `set_input_region_rects` keeps the record so a window can hide and re-create
/// its surface; this is the release path for a wrapper that is discarded for
/// good, so the map does not grow with every temporary window.
pub(super) fn forget_input_region(window_id: &str) -> bool {
    let Ok(_guard) = INPUT_REGION_LOCK.lock() else {
        return false;
    };
    RECORDED_INPUT_REGIONS
        .get()
        .and_then(|regions| regions.lock().ok()?.remove(window_id))
        .is_some()
}

/// Re-key a window's recorded input region under another window id.
///
/// A policy switch replaces the wrapper with a different window; the region
/// follows it and is emitted before the replacement's next commit. Returns
/// whether the registry was reachable; a window with no recorded region is a
/// no-op, not a failure.
pub(super) fn transfer_input_region(from_id: &str, to_id: &str) -> bool {
    if from_id == to_id {
        return true;
    }
    let Ok(_guard) = INPUT_REGION_LOCK.lock() else {
        return false;
    };
    let Some(registry) = RECORDED_INPUT_REGIONS.get() else {
        return true;
    };
    let Ok(mut regions) = registry.lock() else {
        return false;
    };
    let Some(mut region) = regions.remove(from_id) else {
        return true;
    };
    // The replacement's surface has not seen it, whatever the source had.
    region.pending = true;
    regions.insert(to_id.to_string(), region);
    true
}

/// The `set_size` request a layer surface owes before its next commit, if any.
///
/// Like the input region, layer state is double-buffered: the compositor only
/// adopts it at the surface's commit. Emitting the request just before that
/// commit keeps it from being applied a frame late.
pub(super) fn layer_size_requests_for_commit(
    conn: &mut WaylandConn,
    wl_surface_id: u32,
) -> Option<Vec<Vec<u8>>> {
    let (width, height) = conn.layer_sizes.remove(&wl_surface_id)?;
    let layer_id = conn.wl_to_layer.get(&wl_surface_id).copied()?;
    Some(vec![super::layer_shell::set_size(layer_id, width, height)])
}

pub(super) fn send_xdg_toplevel_move() -> bool {
    let Some(button) = LAST_BUTTON
        .get()
        .and_then(|m| m.lock().ok())
        .and_then(|buttons| {
            buttons
                .latest
                .and_then(|key| buttons.by_surface.get(&key).copied())
        })
    else {
        return false;
    };
    let (fd, seat_id, serial, wl_surf_id) = (
        button.fd,
        button.seat_id,
        button.serial,
        button.wl_surface_id,
    );

    let top_id = {
        let Some(conns) = CONNS.get() else {
            return false;
        };
        let Ok(guard) = conns.lock() else {
            return false;
        };
        let Some(conn) = guard.get(&fd) else {
            return false;
        };

        conn.wl_to_top
            .get(&wl_surf_id)
            .copied()
            .filter(|id| conn.ifaces.get(id) == Some(&Iface::XdgToplevel))
            .or_else(|| {
                let xdg_id = conn
                    .xdg_to_wl
                    .iter()
                    .find(|(_, v)| **v == wl_surf_id)
                    .map(|(k, _)| *k);
                xdg_id.and_then(|xid| {
                    conn.top_to_xdg
                        .iter()
                        .filter(|(tid, sid)| {
                            **sid == xid && conn.ifaces.get(tid) == Some(&Iface::XdgToplevel)
                        })
                        .map(|(tid, _)| *tid)
                        .max()
                })
            })
    };

    let Some(top_id) = top_id else {
        return false;
    };

    let hdr_word = (REQ_MOVE as u32) | (16u32 << 16);
    let mut buf = [0u8; 16];
    buf[0..4].copy_from_slice(&top_id.to_ne_bytes());
    buf[4..8].copy_from_slice(&hdr_word.to_ne_bytes());
    buf[8..12].copy_from_slice(&seat_id.to_ne_bytes());
    buf[12..16].copy_from_slice(&serial.to_ne_bytes());

    let Some(sink) = sink_for(fd) else {
        return false;
    };
    sink.send_as_client(&buf)
}

#[cfg(test)]
mod tests {
    use std::io::Read;
    use std::os::fd::AsRawFd;
    use std::os::fd::RawFd;
    use std::os::unix::net::UnixStream;
    use std::sync::MutexGuard;
    use std::sync::mpsc;
    use std::time::Duration;

    use crate::linux::Rect;
    use crate::linux::proxy::{SINKS, Sink};

    use super::super::handlers::{Action, Effects, dispatch_request};
    use super::super::test_support::{request, serial};
    use super::*;

    const WINDOW: &str = "window-1";

    /// The injection path reads two process-global registries: `LAST_BUTTON` and
    /// the connection's surface map (`CONNS`, under the shared `WINDOW` key),
    /// so it takes the one test mutex every global-touching module shares.
    fn lock_press_state() -> MutexGuard<'static, ()> {
        serial()
    }

    /// A connection the proxy can inject into. Injected bytes are written to the
    /// app side of a socketpair, so the test reads them off the peer.
    struct Fixture {
        /// Held so the fd stays open for the lifetime of the test.
        _app: UnixStream,
        peer: UnixStream,
        fd: RawFd,
    }

    impl Fixture {
        fn new() -> Self {
            init_state();
            *LAST_BUTTON.get_or_init(Default::default).lock().unwrap() = LastButtonState::default();

            let (app, peer) = UnixStream::pair().expect("socketpair");
            let fd = app.as_raw_fd();
            let fixture = Self {
                _app: app,
                peer,
                fd,
            };
            fixture.forget();
            fixture.install_sink(fd);
            fixture
        }

        /// Drop the state another test may have left under this fd.
        fn forget(&self) {
            if let Some(m) = CONNS.get() {
                m.lock().unwrap().remove(&self.fd);
            }
            if let Some(m) = SINKS.get() {
                m.lock().unwrap().remove(&self.fd);
            }
        }

        fn install_sink(&self, app_fd: RawFd) {
            SINKS.get_or_init(Default::default).lock().unwrap().insert(
                self.fd,
                Sink {
                    real_fd: self.peer.as_raw_fd(),
                    app_fd,
                    write_lock: None,
                },
            );
        }

        /// A connection with a compositor and one recycled id to hand out.
        fn with_connection(&self) -> &Self {
            let mut conn = WaylandConn::new();
            conn.compositor_id = Some(3);
            conn.stolen_ids.push(50);
            CONNS
                .get_or_init(Default::default)
                .lock()
                .unwrap()
                .insert(self.fd, conn);
            self.with_custom_id(7)
        }

        fn with_custom_id(&self, wl_surface_id: u32) -> &Self {
            self.with_conn(|conn| {
                conn.surface_ids.insert(wl_surface_id, WINDOW.to_string());
            });
            self
        }

        fn with_conn(&self, edit: impl FnOnce(&mut WaylandConn)) -> &Self {
            self.with_conn_ref(edit);
            self
        }

        fn with_conn_ref<T>(&self, read: impl FnOnce(&mut WaylandConn) -> T) -> T {
            let map = CONNS.get().expect("initialised");
            let mut guard = map.lock().unwrap();
            read(guard.get_mut(&self.fd).expect("a connection"))
        }

        /// Everything the proxy injected, in order.
        fn injected(&mut self) -> Vec<u8> {
            self.peer.set_nonblocking(true).expect("nonblocking");
            let mut out = Vec::new();
            let mut buf = [0u8; 4096];
            while let Ok(n) = self.peer.read(&mut buf) {
                if n == 0 {
                    break;
                }
                out.extend_from_slice(&buf[..n]);
            }
            out
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.forget();
        }
    }

    #[test]
    fn recording_a_region_sends_nothing_by_itself() {
        let _serial = lock_press_state();
        let mut fixture = Fixture::new();
        fixture.with_connection();

        assert!(set_input_region_rects(WINDOW, None));

        // It is emitted immediately before the surface's next commit, because
        // that commit is what makes the compositor adopt it.
        assert!(fixture.injected().is_empty());
    }

    #[test]
    fn a_commit_carries_a_layer_size_before_itself() {
        let _serial = lock_press_state();
        let fixture = Fixture::new();
        fixture.with_connection();
        fixture.with_conn(|conn| {
            conn.wl_to_layer.insert(7, 60);
            conn.ifaces
                .insert(60, super::super::codec::Iface::ZwlrLayerSurface);
            conn.layer_sizes.insert(7, (320, 240));
        });

        let requests = fixture
            .with_conn_ref(|conn| layer_size_requests_for_commit(conn, 7))
            .expect("the size is pending");
        assert_eq!(requests.len(), 1);
        assert_eq!(
            super::super::test_support::header(&requests[0]),
            (60, super::super::codec::REQ_LAYER_SET_SIZE, 16)
        );
        assert!(
            fixture.with_conn_ref(|conn| conn.layer_sizes.is_empty()),
            "the size is emitted once"
        );
    }

    #[test]
    fn a_commit_carries_the_region_before_itself() {
        let _serial = lock_press_state();
        let fixture = Fixture::new();
        fixture.with_connection();
        let rects = [
            Rect {
                x: 1,
                y: 2,
                w: 3,
                h: 4,
            },
            Rect {
                x: 5,
                y: 6,
                w: 7,
                h: 8,
            },
        ];
        assert!(set_input_region_rects(WINDOW, Some(&rects)));

        let requests = fixture
            .with_conn_ref(|conn| region_requests_for_commit(conn, 7))
            .expect("the region is pending");
        assert_eq!(
            requests,
            vec![
                request(3, REQ_CREATE_REGION, 12, &[50]),
                request(50, REQ_REGION_ADD, 24, &[1, 2, 3, 4]),
                request(50, REQ_REGION_ADD, 24, &[5, 6, 7, 8]),
                request(7, REQ_SET_INPUT_REGION, 12, &[50]),
                request(50, REQ_REGION_DESTROY, 8, &[]),
            ]
        );

        // The id came from the recycled pool and stays owned until the
        // compositor reports it deleted.
        fixture.with_conn(|conn| {
            assert!(conn.stolen_ids.is_empty());
            assert!(conn.injected_ids.contains(&50));
        });
    }

    #[test]
    fn a_commit_emits_the_region_before_the_commit_itself() {
        let _serial = lock_press_state();
        let fixture = Fixture::new();
        fixture.with_connection();
        // The surface the commit names, as `create_surface` would have recorded.
        fixture.with_conn(|conn| {
            conn.ifaces.insert(7, Iface::WlSurface);
        });
        assert!(set_input_region_rects(WINDOW, None));

        let commit = WlMessage::new(7, REQ_COMMIT, request(7, REQ_COMMIT, 8, &[]));
        let action = fixture.with_conn_ref(|conn| {
            dispatch_request(fixture.fd, conn, &commit, &mut Effects::default())
        });

        let Action::Replace(messages) = action else {
            panic!("a commit with a pending region is emitted with it");
        };
        assert_eq!(
            messages,
            vec![
                request(7, REQ_SET_INPUT_REGION, 12, &[0]),
                commit.raw().to_vec(),
            ],
            "the region precedes the commit that adopts it"
        );
    }

    #[test]
    fn an_unknown_surface_is_left_alone() {
        let _serial = lock_press_state();
        let fixture = Fixture::new();
        fixture.with_connection();
        assert!(set_input_region_rects(WINDOW, None));

        assert!(
            fixture
                .with_conn_ref(|conn| {
                    conn.surface_ids.clear();
                    region_requests_for_commit(conn, 7)
                })
                .is_none(),
            "an id the proxy cannot name has no region to emit"
        );
    }

    #[test]
    fn a_region_is_emitted_once_per_surface() {
        let _serial = lock_press_state();
        let fixture = Fixture::new();
        fixture.with_connection();
        assert!(set_input_region_rects(WINDOW, None));

        assert!(
            fixture
                .with_conn_ref(|conn| region_requests_for_commit(conn, 7))
                .is_some()
        );
        assert!(
            fixture
                .with_conn_ref(|conn| region_requests_for_commit(conn, 7))
                .is_none(),
            "the commit already carried it"
        );

        // A surface re-created for the same window is a new surface, so the
        // region has to reach it again.
        mark_region_pending(WINDOW);
        assert!(
            fixture
                .with_conn_ref(|conn| region_requests_for_commit(conn, 7))
                .is_some()
        );
    }

    #[test]
    fn a_region_without_a_spare_id_stays_pending() {
        let _serial = lock_press_state();
        let fixture = Fixture::new();
        fixture.with_connection();
        // No recycled id, so the region object cannot be built.
        fixture.with_conn(|conn| conn.stolen_ids.clear());
        let rects = [Rect {
            x: 1,
            y: 2,
            w: 3,
            h: 4,
        }];
        assert!(set_input_region_rects(WINDOW, Some(&rects)));

        assert!(
            fixture
                .with_conn_ref(|conn| region_requests_for_commit(conn, 7))
                .is_none(),
            "the commit is not made to carry a region that is not ready"
        );

        // An id comes back; the next commit carries it.
        fixture.with_conn(|conn| conn.stolen_ids.push(50));
        assert_eq!(
            fixture.with_conn_ref(|conn| region_requests_for_commit(conn, 7)),
            Some(vec![
                request(3, REQ_CREATE_REGION, 12, &[50]),
                request(50, REQ_REGION_ADD, 24, &[1, 2, 3, 4]),
                request(7, REQ_SET_INPUT_REGION, 12, &[50]),
                request(50, REQ_REGION_DESTROY, 8, &[]),
            ])
        );
    }

    #[test]
    fn a_region_store_cannot_overtake_a_drain_in_flight() {
        let _serial = lock_press_state();

        // Held, as the proxy thread does while it reads a pending region and
        // clears it. A store arriving now must wait, so the drain cannot emit
        // the older region after the application has recorded a newer one.
        let guard = INPUT_REGION_LOCK.lock().expect("uncontended");

        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let store = std::thread::spawn(move || {
            started_tx.send(()).expect("signalled");
            set_input_region_rects("serialized-window", None);
            done_tx.send(()).expect("signalled");
        });

        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("the storing thread started");
        assert!(
            done_rx.recv_timeout(Duration::from_millis(200)).is_err(),
            "the store must not overtake a drain that is already reading"
        );

        drop(guard);
        done_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("the store completed once the drain ended");
        store.join().expect("joined");
        forget_input_region("serialized-window");
    }

    #[test]
    fn a_discarded_window_can_release_its_recorded_region() {
        let _serial = lock_press_state();
        let fixture = Fixture::new();
        fixture.with_connection();
        assert!(set_input_region_rects(WINDOW, None));

        assert!(forget_input_region(WINDOW));

        // The record is gone, so no commit can emit a region for it.
        assert!(
            fixture
                .with_conn_ref(|conn| region_requests_for_commit(conn, 7))
                .is_none()
        );
        assert!(!forget_input_region(WINDOW), "forgetting twice is a no-op");
    }

    #[test]
    fn a_recorded_region_follows_its_window_to_a_replacement_id() {
        let _serial = lock_press_state();
        let fixture = Fixture::new();
        fixture.with_connection();
        fixture.with_conn(|conn| conn.surface_ids.clear());

        assert!(set_input_region_rects("source-window", None));
        assert!(transfer_input_region("source-window", "replacement-window"));

        // The replacement is not associated with a surface yet.
        assert!(
            fixture
                .with_conn_ref(|conn| region_requests_for_commit(conn, 7))
                .is_none()
        );

        // Once it names the surface, the next commit carries the region.
        fixture.with_conn(|conn| {
            conn.surface_ids.insert(7, "replacement-window".to_string());
        });
        assert_eq!(
            fixture.with_conn_ref(|conn| region_requests_for_commit(conn, 7)),
            Some(vec![request(7, REQ_SET_INPUT_REGION, 12, &[0])])
        );

        // A window with nothing recorded, and a no-op transfer, are both fine.
        assert!(transfer_input_region("nothing-recorded", "elsewhere"));
        assert!(transfer_input_region("same-window", "same-window"));
    }

    #[test]
    fn a_region_needs_a_compositor() {
        let _serial = lock_press_state();
        let fixture = Fixture::new();
        fixture.with_connection();
        fixture.with_conn(|conn| conn.compositor_id = None);
        let rects = [Rect {
            x: 1,
            y: 2,
            w: 3,
            h: 4,
        }];

        // The region is recorded either way; a compositor is only needed to
        // build its requests.
        assert!(set_input_region_rects(WINDOW, Some(&rects)));
        assert!(
            fixture
                .with_conn_ref(|conn| region_requests_for_commit(conn, 7))
                .is_none()
        );

        // It is not forgotten: once a compositor is known, a commit carries it.
        fixture.with_conn(|conn| conn.compositor_id = Some(3));
        assert!(
            fixture
                .with_conn_ref(|conn| region_requests_for_commit(conn, 7))
                .is_some()
        );
    }

    #[test]
    fn a_toplevel_move_replays_the_remembered_press() {
        let _serial = lock_press_state();
        let mut fixture = Fixture::new();
        fixture.with_connection();
        fixture.with_conn(|conn| {
            conn.ifaces.insert(9, Iface::XdgToplevel);
            conn.wl_to_top.insert(7, 9);
        });
        {
            let mut buttons = LAST_BUTTON.get().unwrap().lock().unwrap();
            buttons.by_surface.insert(
                (fixture.fd, 7),
                LastButton {
                    fd: fixture.fd,
                    seat_id: 4,
                    serial: 77,
                    wl_surface_id: 7,
                    x: 0,
                    y: 0,
                    at: std::time::Instant::now(),
                },
            );
            buttons.latest = Some((fixture.fd, 7));
        }

        assert!(send_xdg_toplevel_move());

        assert_eq!(fixture.injected(), request(9, REQ_MOVE, 16, &[4, 77]));
    }

    #[test]
    fn a_toplevel_move_falls_back_to_the_xdg_chain() {
        let _serial = lock_press_state();
        let mut fixture = Fixture::new();
        fixture.with_connection();
        fixture.with_conn(|conn| {
            conn.xdg_to_wl.insert(20, 7);
            conn.top_to_xdg.insert(30, 20);
            conn.top_to_xdg.insert(40, 20);
            conn.ifaces.insert(30, Iface::XdgToplevel);
            conn.ifaces.insert(40, Iface::XdgToplevel);
        });
        {
            let mut buttons = LAST_BUTTON.get().unwrap().lock().unwrap();
            buttons.by_surface.insert(
                (fixture.fd, 7),
                LastButton {
                    fd: fixture.fd,
                    seat_id: 4,
                    serial: 77,
                    wl_surface_id: 7,
                    x: 0,
                    y: 0,
                    at: std::time::Instant::now(),
                },
            );
            buttons.latest = Some((fixture.fd, 7));
        }

        assert!(send_xdg_toplevel_move());

        assert_eq!(
            fixture.injected(),
            request(40, REQ_MOVE, 16, &[4, 77]),
            "the highest candidate wins"
        );
    }

    #[test]
    fn a_toplevel_move_needs_a_press_a_toplevel_and_a_sink() {
        let _serial = lock_press_state();
        let mut fixture = Fixture::new();
        fixture.with_connection();

        // No press has been seen yet.
        assert!(!send_xdg_toplevel_move());

        // A press, but the focused surface is not a toplevel.
        {
            let mut buttons = LAST_BUTTON.get().unwrap().lock().unwrap();
            buttons.by_surface.insert(
                (fixture.fd, 7),
                LastButton {
                    fd: fixture.fd,
                    seat_id: 4,
                    serial: 77,
                    wl_surface_id: 7,
                    x: 0,
                    y: 0,
                    at: std::time::Instant::now(),
                },
            );
            buttons.latest = Some((fixture.fd, 7));
        }
        fixture.with_conn(|conn| {
            conn.ifaces.insert(7, Iface::WlSurface);
            conn.wl_to_top.insert(7, 9);
        });
        assert!(!send_xdg_toplevel_move());

        // A toplevel, but no sink left to inject through.
        fixture.with_conn(|conn| {
            conn.ifaces.insert(9, Iface::XdgToplevel);
        });
        SINKS.get().unwrap().lock().unwrap().remove(&fixture.fd);
        assert!(!send_xdg_toplevel_move());

        assert!(fixture.injected().is_empty(), "nothing was ever injected");
    }
}
