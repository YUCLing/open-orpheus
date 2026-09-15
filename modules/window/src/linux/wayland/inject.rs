use std::os::fd::RawFd;

use crate::linux::Rect;

use super::super::proxy::sink_for;
use super::codec::*;
use super::state::*;

fn window_id_to_fd_and_surface(window_id: &str) -> Option<(RawFd, u32)> {
    if let Some(m) = CUSTOM_ID_MAP.get()
        && let Ok(map) = m.lock()
        && let Some(&val) = map.get(window_id)
    {
        return Some(val);
    }
    None
}

fn create_region(fd: RawFd) -> Option<u32> {
    let (compositor_id, region_id) = {
        let conns = CONNS.get()?;
        let Ok(mut guard) = conns.lock() else {
            return None;
        };
        let conn = guard.get_mut(&fd)?;
        let compositor_id = conn.compositor_id?;
        let region_id = conn.alloc_injected_id()?;
        (compositor_id, region_id)
    };

    let hdr_word = (REQ_CREATE_REGION as u32) | (12u32 << 16);
    let mut buf = [0u8; 12];
    buf[0..4].copy_from_slice(&compositor_id.to_ne_bytes());
    buf[4..8].copy_from_slice(&hdr_word.to_ne_bytes());
    buf[8..12].copy_from_slice(&region_id.to_ne_bytes());

    let sink = sink_for(fd)?;
    if !sink.send_as_client(&buf) {
        let conns = CONNS.get()?;
        let Ok(mut guard) = conns.lock() else {
            return None;
        };
        if let Some(conn) = guard.get_mut(&fd) {
            conn.injected_ids.remove(&region_id);
            // Return it to the pool if we failed to send
            conn.stolen_ids.push(region_id);
        }
        return None;
    }

    Some(region_id)
}

fn region_add(fd: RawFd, region_id: u32, x: i32, y: i32, w: i32, h: i32) -> bool {
    let hdr_word = (REQ_REGION_ADD as u32) | (24u32 << 16);
    let mut buf = [0u8; 24];
    buf[0..4].copy_from_slice(&region_id.to_ne_bytes());
    buf[4..8].copy_from_slice(&hdr_word.to_ne_bytes());
    buf[8..12].copy_from_slice(&x.to_ne_bytes());
    buf[12..16].copy_from_slice(&y.to_ne_bytes());
    buf[16..20].copy_from_slice(&w.to_ne_bytes());
    buf[20..24].copy_from_slice(&h.to_ne_bytes());

    let Some(sink) = sink_for(fd) else {
        return false;
    };
    sink.send_as_client(&buf)
}

fn destroy_injected_region(fd: RawFd, region_id: u32) {
    let hdr_word = (REQ_REGION_DESTROY as u32) | (8u32 << 16);
    let mut buf = [0u8; 8];
    buf[0..4].copy_from_slice(&region_id.to_ne_bytes());
    buf[4..8].copy_from_slice(&hdr_word.to_ne_bytes());

    if let Some(sink) = sink_for(fd) {
        sink.send_as_client(&buf);
    }
}

pub(super) fn set_input_region_rects(window_id: &str, rects: Option<&[Rect]>) -> bool {
    let (fd, wl_surface_id) = match window_id_to_fd_and_surface(window_id) {
        Some(v) => v,
        None => return false,
    };

    let mut region_id = 0;

    if let Some(rects) = rects {
        if let Some(r_id) = create_region(fd) {
            region_id = r_id;
            for r in rects {
                if !region_add(fd, region_id, r.x, r.y, r.w, r.h) {
                    destroy_injected_region(fd, region_id);
                    return false;
                }
            }
        } else {
            return false;
        }
    }

    let hdr_word = (REQ_SET_INPUT_REGION as u32) | (12u32 << 16);
    let mut buf = [0u8; 12];
    buf[0..4].copy_from_slice(&wl_surface_id.to_ne_bytes());
    buf[4..8].copy_from_slice(&hdr_word.to_ne_bytes());
    buf[8..12].copy_from_slice(&region_id.to_ne_bytes()); // "0" acts safely as null identifier

    let Some(sink) = sink_for(fd) else {
        return false;
    };
    let res = sink.send_as_client(&buf);

    if region_id != 0 {
        // Drop cache proxy directly. Re-allocation operates identically upon delete_id.
        destroy_injected_region(fd, region_id);
    }

    res
}

pub(super) fn send_xdg_toplevel_move() -> bool {
    let Some((fd, seat_id, serial, wl_surf_id)) = LAST_BUTTON
        .get()
        .and_then(|m| m.lock().ok())
        .and_then(|g| *g)
    else {
        return false;
    };

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
    use std::os::unix::net::UnixStream;
    use std::sync::{Mutex, MutexGuard};

    use crate::linux::Rect;
    use crate::linux::proxy::{SINKS, Sink};

    use super::super::test_support::request;
    use super::*;

    const WINDOW: &str = "window-1";

    /// The injection path reads two process-global registries: `LAST_BUTTON` and
    /// `CUSTOM_ID_MAP` (under the shared `WINDOW` key). Tests therefore run one
    /// at a time rather than fighting over them.
    static PRESS_STATE: Mutex<()> = Mutex::new(());

    fn lock_press_state() -> MutexGuard<'static, ()> {
        PRESS_STATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
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
            LAST_BUTTON
                .get_or_init(Default::default)
                .lock()
                .unwrap()
                .take();

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
            CUSTOM_ID_MAP
                .get()
                .expect("initialised")
                .lock()
                .unwrap()
                .insert(WINDOW.to_string(), (self.fd, wl_surface_id));
            self
        }

        fn with_conn(&self, edit: impl FnOnce(&mut WaylandConn)) -> &Self {
            let map = CONNS.get().expect("initialised");
            let mut guard = map.lock().unwrap();
            edit(guard.get_mut(&self.fd).expect("a connection"));
            self
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
            if let Some(m) = CUSTOM_ID_MAP.get() {
                m.lock().unwrap().remove(WINDOW);
            }
        }
    }

    #[test]
    fn clearing_the_input_region_sends_only_the_surface_request() {
        let _serial = lock_press_state();
        let mut fixture = Fixture::new();
        fixture.with_connection();

        assert!(set_input_region_rects(WINDOW, None));

        assert_eq!(
            fixture.injected(),
            request(7, REQ_SET_INPUT_REGION, 12, &[0]),
            "a null region clears the input region"
        );
    }

    #[test]
    fn setting_rects_creates_populates_assigns_and_releases_the_region() {
        let _serial = lock_press_state();
        let mut fixture = Fixture::new();
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

        let expected: Vec<u8> = [
            request(3, REQ_CREATE_REGION, 12, &[50]),
            request(50, REQ_REGION_ADD, 24, &[1, 2, 3, 4]),
            request(50, REQ_REGION_ADD, 24, &[5, 6, 7, 8]),
            request(7, REQ_SET_INPUT_REGION, 12, &[50]),
            request(50, REQ_REGION_DESTROY, 8, &[]),
        ]
        .concat();
        assert_eq!(fixture.injected(), expected);

        // The id came from the recycled pool and stays owned until the
        // compositor reports it deleted.
        fixture.with_conn(|conn| {
            assert!(conn.stolen_ids.is_empty());
            assert!(conn.injected_ids.contains(&50));
        });
    }

    #[test]
    fn an_unknown_window_id_injects_nothing() {
        let _serial = lock_press_state();
        let mut fixture = Fixture::new();
        fixture.with_connection();

        assert!(!set_input_region_rects("window-unknown", None));

        assert!(fixture.injected().is_empty());
    }

    #[test]
    fn a_region_needs_a_compositor() {
        let _serial = lock_press_state();
        let mut fixture = Fixture::new();
        fixture.with_connection();
        fixture.with_conn(|conn| conn.compositor_id = None);
        let rects = [Rect {
            x: 1,
            y: 2,
            w: 3,
            h: 4,
        }];

        assert!(!set_input_region_rects(WINDOW, Some(&rects)));

        assert!(fixture.injected().is_empty());
    }

    #[test]
    fn a_failed_injection_returns_the_id_to_the_pool() {
        let _serial = lock_press_state();
        let fixture = Fixture::new();
        fixture.with_connection();

        // Point the sink at a descriptor that can never be valid, so the send
        // fails the way it would if the client had gone away. Closing a socket
        // here would free its number for a concurrent test to reallocate.
        fixture.install_sink(-1);

        let rects = [Rect {
            x: 1,
            y: 2,
            w: 3,
            h: 4,
        }];
        assert!(!set_input_region_rects(WINDOW, Some(&rects)));

        fixture.with_conn(|conn| {
            assert!(!conn.injected_ids.contains(&50), "the id is not owned");
            assert_eq!(conn.stolen_ids, vec![50], "it went back to the pool");
        });
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
        *LAST_BUTTON.get().unwrap().lock().unwrap() = Some((fixture.fd, 4, 77, 7));

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
        *LAST_BUTTON.get().unwrap().lock().unwrap() = Some((fixture.fd, 4, 77, 7));

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
        *LAST_BUTTON.get().unwrap().lock().unwrap() = Some((fixture.fd, 4, 77, 7));
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
