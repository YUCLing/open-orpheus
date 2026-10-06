//! Connection-setup injection: the requests sent immediately after the X11
//! handshake (InternAtom for `_NET_WM_MOVERESIZE` and the EWMH window-type and
//! state atoms, QueryExtension `SHAPE` and `XInputExtension`). Their replies
//! are dropped and parsed by [`super::replies`].

use super::super::codec::*;
use super::super::state::{InjectedType, X11Conn};

/// One `InternAtom` request for `name` (8 bytes of header, then the padded
/// name), recording it as an injected request whose reply is to be harvested.
fn intern_atom(conn: &mut X11Conn, name: &str, kind: InjectedType) -> Vec<u8> {
    let padded = (name.len() + 3) & !3;
    let mut req = vec![0u8; 8 + padded];
    req[0] = 16; // InternAtom
    write_u16(&mut req[2..4], ((8 + padded) / 4) as u16, conn.is_le);
    write_u16(&mut req[4..6], name.len() as u16, conn.is_le);
    req[8..8 + name.len()].copy_from_slice(name.as_bytes());
    conn.server_seq = conn.server_seq.wrapping_add(1);
    conn.seq_offset = conn.seq_offset.wrapping_add(1);
    conn.injected_seqs.insert(conn.server_seq, kind);
    req
}

pub(crate) fn initial_requests(conn: &mut X11Conn) -> Vec<Vec<u8>> {
    let mut requests = vec![intern_atom(
        conn,
        "_NET_WM_MOVERESIZE",
        InjectedType::InternAtomNetWmMoveresize,
    )];
    // The offset applies from the first injected request onwards, so it has to
    // be captured before the rest of the probes advance the counters.
    let first_injected_seq = conn.server_seq;
    requests.push(intern_atom(
        conn,
        "_NET_WM_WINDOW_TYPE",
        InjectedType::InternAtomNetWmWindowType,
    ));
    requests.push(intern_atom(
        conn,
        "_NET_WM_WINDOW_TYPE_DESKTOP",
        InjectedType::InternAtomNetWmWindowTypeDesktop,
    ));
    requests.push(intern_atom(
        conn,
        "_NET_WM_STATE",
        InjectedType::InternAtomNetWmState,
    ));
    requests.push(intern_atom(
        conn,
        "_NET_WM_STATE_BELOW",
        InjectedType::InternAtomNetWmStateBelow,
    ));

    let mut req2 = [0u8; 16];
    req2[0] = 98; // QueryExtension
    write_u16(&mut req2[2..4], 4, conn.is_le);
    write_u16(&mut req2[4..6], 5, conn.is_le);
    req2[8..13].copy_from_slice(b"SHAPE");
    conn.server_seq = conn.server_seq.wrapping_add(1);
    conn.seq_offset = conn.seq_offset.wrapping_add(1);
    conn.injected_seqs
        .insert(conn.server_seq, InjectedType::QueryExtensionShape);
    requests.push(req2.to_vec());

    let mut req3 = [0u8; 24];
    req3[0] = 98; // QueryExtension
    write_u16(&mut req3[2..4], 6, conn.is_le);
    write_u16(&mut req3[4..6], 15, conn.is_le);
    req3[8..23].copy_from_slice(b"XInputExtension");
    conn.server_seq = conn.server_seq.wrapping_add(1);
    conn.seq_offset = conn.seq_offset.wrapping_add(1);
    conn.injected_seqs
        .insert(conn.server_seq, InjectedType::QueryExtensionXInput);
    requests.push(req3.to_vec());

    // Offset takes effect at the first injected sequence;
    // see `X11Conn::begin_injected_requests` for why this matters. These
    // setup requests never emit events themselves, so their replies being
    // dropped means the exact transition base is immaterial to the client.
    conn.offset_transitions
        .push((first_injected_seq, conn.seq_offset));

    requests
}
