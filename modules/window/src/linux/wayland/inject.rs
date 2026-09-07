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
    let Some(button) = LAST_BUTTON
        .get()
        .and_then(|m| m.lock().ok())
        .and_then(|g| *g)
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
