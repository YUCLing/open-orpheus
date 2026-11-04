//! Interactive move and resize for a window the compositor knows as a layer
//! surface.
//!
//! Layer shell has neither: a layer surface's position and size belong to the
//! application, and only `set_margin` / `set_size` can change them. A converted
//! window still asks for both — `xdg_toplevel.move` from the application's own
//! drag, `resize` from the window's edge hit test — so the proxy replays the
//! gesture itself, from the two things a client is told: where the pointer is
//! within the surface, and the geometry the surface has.
//!
//! What a gesture is after is how far the pointer has moved since it grabbed
//! the window, and a motion event already says exactly that: for as long as the
//! button is down the compositor keeps measuring the pointer against the
//! geometry the press was made on, so the pointer's place in those coordinates
//! is the place it grabbed the window at plus everything it has done since. The
//! window's own movement is not in the numbers, which is what makes this work
//! at all — a gesture that rewrites the window's margins can read its own
//! progress back out of the pointer.
//!
//! The one thing that follows from that is that a step must never be added to
//! the previous step. The pointer's place in the surface is measured from the
//! press, not from the geometry the last step asked for, so adding a step to a
//! step counts everything the drag has done again on every event: a hundred
//! pixels of pointer would carry the window eight hundred. Every step here is
//! computed from the gesture's start instead, so a batch of events and a single
//! event land the window in the same place.
//!
//! Only a surface anchored to the top and left edges can be driven this way:
//! with those anchors the margins *are* the position. Any other shape keeps the
//! place the compositor gave it — as it does today — and the gesture is dropped.
//!
//! ## Running out of screen
//!
//! A layer surface keeps the output it was created on for its whole life, so a
//! gesture that reaches the edge of that output can go no further. The window
//! is held there with a strip of itself still on screen — losing it would leave
//! the user nothing to grab — and the pointer carries on out of it, which is
//! the one thing a window that is following the pointer never does. That is a
//! push past the edge, and it is reported when the button comes up, so the
//! application can build the window again on the screen next to this one.

use std::os::fd::RawFd;

use super::super::codec::{REQ_MOVE, REQ_RESIZE, WlMessage};
use super::super::inject;
use super::super::layer_shell::{ANCHOR_LEFT, ANCHOR_TOP};
use super::super::state::{
    GrabMode, LAST_BUTTON, LastButton, LayerGeometry, LayerGrab, SurfaceRole, WaylandConn,
    fire_layer_geometry, fire_layer_pushed, keep_inside, layer_bounds, layer_geometry,
    margin_range, remember_layer_geometry, set_layer_geometry,
};
use super::{Action, Effects, layer_debug, layer_note};

/// `xdg_toplevel.resize` edge flags, from the protocol.
const EDGE_TOP: u32 = 1;
const EDGE_BOTTOM: u32 = 2;
const EDGE_LEFT: u32 = 4;
const EDGE_RIGHT: u32 = 8;

/// Floor for an interactive resize, so a fast pointer cannot ask for a size the
/// compositor would refuse to draw.
const MIN_SIZE: i32 = 32;

/// Replay `msg`, which asks for a move or a resize of a layer surface.
///
/// Always suppresses: the request names an id the compositor knows as a layer
/// surface, where the xdg-toplevel opcode means something else entirely —
/// `move` is `get_popup` there, and `resize` is `ack_configure`.
pub(crate) fn begin(fd: RawFd, conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    match start(fd, conn, msg) {
        Ok(grab) => {
            // Whether the screen's size is known decides what a drag can do
            // when it reaches the edge, so it is worth saying out loud every
            // time a gesture starts.
            let bounds = layer_bounds(conn, msg.object_id);
            layer_note(|| {
                format!(
                    "gesture on {}: {:?} of {}x{} at ({}, {}), screen {bounds:?}",
                    grab.layer_id,
                    grab.mode,
                    grab.size.0,
                    grab.size.1,
                    grab.margins.0,
                    grab.margins.1
                )
            });
            conn.layer_grab = Some(grab);
        }
        Err(reason) => layer_note(|| format!("gesture on {} refused: {reason}", msg.object_id)),
    }
    Action::Suppress
}

fn start(fd: RawFd, conn: &WaylandConn, msg: &WlMessage) -> Result<LayerGrab, &'static str> {
    let layer = conn
        .layer_windows
        .get(&msg.object_id)
        .ok_or("not a converted window")?;
    let wl_surface = layer.wl_surface;

    // Margins only express a position under these two anchors; anything else
    // would need the compositor's own placement, which a client cannot read.
    match conn.surface_roles.get(&wl_surface) {
        Some(SurfaceRole::Layer(options)) if options.anchor == ANCHOR_TOP | ANCHOR_LEFT => {}
        _ => return Err("not anchored to the top left, so the margins are not its position"),
    }

    let seat_id = msg.u32_arg(8).ok_or("no seat")?;
    let serial = msg.u32_arg(12).ok_or("no serial")?;
    if !serial_started_a_gesture(fd, conn, wl_surface, serial) {
        return Err("the serial names no press or pointer enter on this surface");
    }

    let mode = match msg.opcode {
        REQ_MOVE => GrabMode::Move,
        REQ_RESIZE => GrabMode::Resize(msg.u32_arg(16).ok_or("no edges")?),
        _ => return Err("neither a move nor a resize"),
    };

    // The gesture is driven by the pointer that is on the window; without one
    // there is no motion to follow.
    let (pointer_id, position) = conn
        .pointer_focus
        .iter()
        .find(|(pointer, surface)| {
            **surface == wl_surface && conn.pointer_seat.get(pointer) == Some(&seat_id)
        })
        .and_then(|(pointer, _)| conn.pointer_position.get(pointer).map(|p| (*pointer, *p)))
        .ok_or("no pointer on the window")?;

    // The button that press was made with, for the gestures that started from
    // one: a gesture started from a pointer enter has none, and one whose press
    // said nothing about its button is treated the same way.
    let button = press_for(fd, wl_surface, serial)
        .and_then(|press| (press.button != 0).then_some(press.button));

    let geometry = layer.geometry;
    Ok(LayerGrab {
        layer_id: msg.object_id,
        wl_surface,
        pointer_id,
        mode,
        button,
        origin: (position.0 as f64, position.1 as f64),
        left: false,
        size: (geometry.width, geometry.height),
        margins: (geometry.margin_left, geometry.margin_top),
    })
}

/// Whether `serial` is the press (or the pointer enter) a gesture may name.
///
/// A stale serial has to be refused: replaying on one would hand the window to
/// a pointer that never grabbed it.
fn serial_started_a_gesture(fd: RawFd, conn: &WaylandConn, wl_surface: u32, serial: u32) -> bool {
    conn.pointer_enter_serial.get(&wl_surface) == Some(&serial)
        || press_for(fd, wl_surface, serial).is_some()
}

/// The press `serial` names on `wl_surface`, if that is what it is.
fn press_for(fd: RawFd, wl_surface: u32, serial: u32) -> Option<LastButton> {
    let buttons = LAST_BUTTON.get()?.lock().ok()?;
    let press = *buttons.by_surface.get(&(fd, wl_surface))?;
    (press.serial == serial).then_some(press)
}

/// Follow the pointer of an in-flight gesture and return the layer requests
/// that put the window under it.
pub(crate) fn on_motion(conn: &mut WaylandConn, fx: &mut Effects, pointer_id: u32, x: f64, y: f64) {
    let Some(grab) = conn.layer_grab.clone() else {
        return;
    };
    if grab.pointer_id != pointer_id {
        return;
    }
    let Some((current, wl_surface)) = conn
        .layer_windows
        .get(&grab.layer_id)
        .map(|layer| (layer.geometry, layer.wl_surface))
    else {
        conn.layer_grab = None;
        return;
    };
    let bounds = layer_bounds(conn, grab.layer_id);
    let target = resolve(&grab, bounds, x, y);

    // The button press holds the pointer to the window for as long as it is
    // down, so the motion events keep coming even once the pointer is no longer
    // over the window — which is the only way a drag that has been pushed past
    // the edge can be noticed at all.
    let outside = grab.mode == GrabMode::Move && pointer_outside(target, in_output(&grab, x, y));
    if let Some(grab) = conn.layer_grab.as_mut() {
        grab.left = outside;
    }

    if current == target {
        return;
    }

    layer_debug(|| format!("{}: {current:?} -> {target:?}", grab.layer_id));
    let mut requests = geometry_requests(grab.layer_id, current, target);
    requests.push(inject::surface_commit_request(wl_surface));
    set_layer_geometry(conn, grab.layer_id, target);
    fx.layer_requests.extend(requests);
}

/// Whether the pointer has been dragged clear of the window.
///
/// A window that follows the pointer keeps the pointer on itself: the two move
/// together, so the pointer stays where the gesture grabbed it. A pointer
/// dragged off the window is one the window could not keep up with — the edge
/// of the screen it lives on — and where it is now is what counts, not where it
/// has been, so a step the compositor rounded past the edge before the window
/// moved is taken back by the next one.
///
/// `pointer` is the pointer's own position in the output, which the two halves
/// of the question between them have: the position in the window the compositor
/// reported, and the position of the window itself.
fn pointer_outside(geometry: LayerGeometry, pointer: (f64, f64)) -> bool {
    let (x, y) = pointer;
    let (left, top) = (geometry.margin_left as f64, geometry.margin_top as f64);
    let (right, bottom) = (left + geometry.width as f64, top + geometry.height as f64);
    x < left || y < top || x >= right || y >= bottom
}

/// Where the pointer is in the output, as far as the gesture can tell.
///
/// The coordinates a grab is given are the ones the press established and never
/// move under it, so the window's position when the gesture started is the
/// origin they are measured from — not the position the gesture has moved it to
/// since.
fn in_output(grab: &LayerGrab, x: f64, y: f64) -> (f64, f64) {
    (grab.margins.0 as f64 + x, grab.margins.1 as f64 + y)
}

/// How far the pointer has moved since it grabbed the window.
fn moved(grab: &LayerGrab, x: f64, y: f64) -> (f64, f64) {
    (x - grab.origin.0, y - grab.origin.1)
}

/// The geometry `grab` asks for while the pointer is at `(x, y)`.
fn resolve(grab: &LayerGrab, bounds: Option<(u32, u32)>, x: f64, y: f64) -> LayerGeometry {
    let (dx, dy) = moved(grab, x, y);
    let dx = dx.round() as i32;
    let dy = dy.round() as i32;
    let mut geometry = match grab.mode {
        // The window is dragged by as much as the pointer has moved, from where
        // the gesture found it — never from the previous step.
        GrabMode::Move => LayerGeometry {
            width: grab.size.0,
            height: grab.size.1,
            margin_left: grab.margins.0 + dx,
            margin_top: grab.margins.1 + dy,
        },
        // A resize works in the same movement, but only the edges the user
        // grabbed follow it: the opposite ones stay exactly where they were.
        GrabMode::Resize(edges) => {
            let width = grab.size.0 as i32;
            let height = grab.size.1 as i32;
            let mut geometry = LayerGeometry {
                width: grab.size.0,
                height: grab.size.1,
                margin_left: grab.margins.0,
                margin_top: grab.margins.1,
            };
            if edges & EDGE_RIGHT != 0 {
                geometry.width = clamp_size(width + dx);
            }
            if edges & EDGE_LEFT != 0 {
                geometry.width = clamp_size(width - dx);
                // The opposite edge stays put, so the margin follows whatever
                // the clamp did to the size.
                geometry.margin_left += width - geometry.width as i32;
            }
            if edges & EDGE_BOTTOM != 0 {
                geometry.height = clamp_size(height + dy);
            }
            if edges & EDGE_TOP != 0 {
                geometry.height = clamp_size(height - dy);
                geometry.margin_top += height - geometry.height as i32;
            }
            geometry
        }
    };
    if let Some((width, height)) = bounds {
        geometry.margin_left = keep_inside(geometry.margin_left, geometry.width, width);
        geometry.margin_top = keep_inside(geometry.margin_top, geometry.height, height);
    }
    geometry
}

fn clamp_size(value: i32) -> u32 {
    value.max(MIN_SIZE) as u32
}

/// The requests that turn `from` into `to`, in the order the compositor wants
/// them. Right and bottom margins stay `0`: they belong to edges the window is
/// not anchored to.
pub(crate) fn geometry_requests(
    layer_id: u32,
    from: LayerGeometry,
    to: LayerGeometry,
) -> Vec<Vec<u8>> {
    let mut requests = Vec::new();
    if (from.width, from.height) != (to.width, to.height) {
        requests.push(super::super::layer_shell::set_size(
            layer_id, to.width, to.height,
        ));
    }
    if (from.margin_left, from.margin_top) != (to.margin_left, to.margin_top) {
        requests.push(super::super::layer_shell::set_margin(
            layer_id,
            [to.margin_top, 0, 0, to.margin_left],
        ));
    }
    requests
}

/// End the gesture driven by `pointer_id`, if it is the one in flight.
///
/// A gesture that ended with the window pinned at the edge of the output it
/// lives on and the pointer outside it is a user pushing past that edge: a
/// layer surface can never be moved to another output, so the only way to put
/// the window where it was pushed is to build it again there, and the
/// application is told which edge to build it against.
pub(crate) fn on_pointer_button_release(
    conn: &mut WaylandConn,
    pointer_id: u32,
    released: Option<u32>,
) -> bool {
    let Some(grab) = conn.layer_grab.clone() else {
        return false;
    };
    if grab.pointer_id != pointer_id {
        return false;
    }
    // The gesture belongs to the button it was started with: another one
    // pressed and released in the middle of a drag is not the drag ending.
    // Ending it there would stop the window following the pointer, and against
    // an edge it would report a push the user never made.
    if let (Some(started), Some(released)) = (grab.button, released)
        && started != released
    {
        return false;
    }
    remember(conn, &grab);
    conn.layer_grab = None;

    // Only a drag can run out of screen — a resize keeps the window's corner
    // where it is — and only a pointer that left the window while it was pinned
    // was pushing: a window merely parked at the edge has the pointer inside
    // it, exactly like any other.
    let edges = match grab.left && grab.mode == GrabMode::Move {
        true => pushed_edges(conn, &grab),
        false => 0,
    };
    if edges == 0 {
        return true;
    }
    if let Some((window_id, _)) = layer_geometry(conn, grab.layer_id) {
        layer_note(|| format!("{window_id} was pushed past the edge: {edges}"));
        fire_layer_pushed(&window_id, edges);
    }
    true
}

/// End the gesture on `wl_surface`, if there is one, and mark it as pushed out.
///
/// A button press holds the pointer to the window it was made on, so a drag
/// normally never sees this: the pointer's position, not the surface it is over,
/// is what says whether the window still has it. A compositor that does hand
/// the focus on gets the same answer from here.
///
/// Where the output's size is known the gesture stays in flight either way: the
/// window is held inside the output, so a pointer that is no longer over it is
/// one pushing past the edge, and the button decides what that meant. Where the
/// size is not known the window can have been dragged anywhere, and putting it
/// back where the gesture found it is the one outcome that cannot leave the
/// user with a window they can neither see nor reach.
pub(crate) fn on_surface_left(conn: &mut WaylandConn, fx: &mut Effects, wl_surface: u32) {
    let Some(grab) = conn.layer_grab.as_ref() else {
        return;
    };
    if grab.wl_surface != wl_surface {
        return;
    }
    let layer_id = grab.layer_id;
    if let Some(grab) = conn.layer_grab.as_mut() {
        grab.left = true;
    }
    if layer_bounds(conn, layer_id).is_some() {
        layer_note(|| format!("the pointer left the gesture on {layer_id}"));
        return;
    }
    undo(conn, fx);
}

/// The edges a gesture was pushing against when the button came up, or `0`.
///
/// A gesture that has reached an edge can move the window no further — it is
/// pinned there, and every further step of the pointer is spent on nothing.
/// Since a layer surface cannot leave the output it was created on, that is
/// also where the window has to be created again, on the one next to it.
fn pushed_edges(conn: &WaylandConn, grab: &LayerGrab) -> u32 {
    let Some(bounds) = layer_bounds(conn, grab.layer_id) else {
        return 0;
    };
    let Some(geometry) = conn
        .layer_windows
        .get(&grab.layer_id)
        .map(|layer| layer.geometry)
    else {
        return 0;
    };
    let mut edges = 0;
    if let Some((least, most)) = margin_range(geometry.width, bounds.0) {
        if geometry.margin_left <= least {
            edges |= EDGE_LEFT;
        }
        if geometry.margin_left >= most {
            edges |= EDGE_RIGHT;
        }
    }
    if let Some((least, most)) = margin_range(geometry.height, bounds.1) {
        if geometry.margin_top <= least {
            edges |= EDGE_TOP;
        }
        if geometry.margin_top >= most {
            edges |= EDGE_BOTTOM;
        }
    }
    edges
}

/// Put the surface back where the gesture found it.
fn undo(conn: &mut WaylandConn, fx: &mut Effects) {
    let Some(grab) = conn.layer_grab.take() else {
        return;
    };
    let restored = LayerGeometry {
        width: grab.size.0,
        height: grab.size.1,
        margin_left: grab.margins.0,
        margin_top: grab.margins.1,
    };
    let Some(current) = conn
        .layer_windows
        .get(&grab.layer_id)
        .map(|layer| layer.geometry)
    else {
        return;
    };
    if current == restored {
        return;
    }

    layer_note(|| {
        format!(
            "undoing the gesture on {}: {current:?} -> {restored:?}",
            grab.layer_id
        )
    });
    let mut requests = geometry_requests(grab.layer_id, current, restored);
    requests.push(inject::surface_commit_request(grab.wl_surface));
    set_layer_geometry(conn, grab.layer_id, restored);
    fx.layer_requests.extend(requests);
}

/// Write where the gesture left the window into the window's own policy, so a
/// re-created window comes back there.
///
/// The window on screen keeps the geometry either way: a *hidden and shown*
/// window reuses the same surface, whose role is re-applied from the cached
/// decision. Only a window the application destroys and builds again reads the
/// policy.
fn remember(conn: &WaylandConn, grab: &LayerGrab) {
    remember_layer_geometry(conn, grab.layer_id);
    // The application asked to be told: a compositor never tells a client where
    // its surface is, so this is the only way a window it re-creates can come
    // back to the place the user left it.
    if let Some((window_id, geometry)) = layer_geometry(conn, grab.layer_id) {
        fire_layer_geometry(&window_id, geometry);
    }
}

#[cfg(test)]
mod tests {
    use super::super::super::codec::{Iface, REQ_COMMIT, REQ_LAYER_SET_MARGIN, REQ_LAYER_SET_SIZE};
    use super::super::super::layer_shell::LayerShellOptions;
    use super::super::super::state::{
        LastButton, LastButtonState, LayerGeometry, LayerWindow, OutputInfo, SurfaceRole,
        clear_all_layer_policies, layer_policy, set_layer_policy,
    };
    use std::time::Instant;

    /// The button every gesture in these tests is started with.
    const BUTTON: u32 = 0x110;

    use super::super::super::test_support::{connected, header, message, request, serial, word};
    use super::*;

    const FD: RawFd = 42;
    /// The client's toplevel id, reused by the proxy as the layer surface id.
    const LAYER: u32 = 30;
    const SURFACE: u32 = 10;
    const POINTER: u32 = 40;
    const SEAT: u32 = 2;
    const SERIAL: u32 = 77;
    /// Where the pointer was when the gesture started, in surface coordinates.
    const ORIGIN: (f64, f64) = (100.0, 200.0);
    /// The same point in the coordinates the window is placed in, which is
    /// where a pointer stays for the whole of a drag.
    const WORLD: (f64, f64) = (40.0 + ORIGIN.0, 60.0 + ORIGIN.1);
    /// The geometry every window in these tests starts with.
    const START: LayerGeometry = LayerGeometry {
        width: 800,
        height: 225,
        margin_left: 40,
        margin_top: 60,
    };

    thread_local! {
        /// The geometry a gesture's coordinates are measured against, which the
        /// press fixes for the whole of it.
        ///
        /// Held here rather than read back from the gesture under test: what a
        /// drag makes of that geometry is the whole question — it is what the
        /// drag reads its own progress out of — and reading the answer back
        /// would make any implementation agree with itself.
        static GRABBED_IN: std::cell::Cell<LayerGeometry> = const { std::cell::Cell::new(START) };
    }

    /// The commit that makes a geometry change take effect.
    fn commit() -> Vec<u8> {
        request(SURFACE, REQ_COMMIT, 8, &[])
    }

    /// Run one motion through the handler, as the pointer event would.
    fn motion(conn: &mut WaylandConn, x: f64, y: f64) -> Effects {
        let mut fx = Effects::default();
        on_motion(conn, &mut fx, POINTER, x, y);
        fx
    }

    /// The geometry a motion event's coordinates are measured against.
    fn frame() -> LayerGeometry {
        GRABBED_IN.with(|has| has.get())
    }

    /// Put the pointer at `world` in the coordinates the window is placed in.
    ///
    /// Which means: report its position within the window, measured against the
    /// geometry the compositor has, exactly as a motion event carries it.
    fn drag(conn: &mut WaylandConn, world: (f64, f64)) -> Effects {
        let frame = frame();
        motion(
            conn,
            world.0 - frame.margin_left as f64,
            world.1 - frame.margin_top as f64,
        )
    }

    /// The requests one motion wants sent to the compositor.
    fn requests(conn: &mut WaylandConn, x: f64, y: f64) -> Vec<Vec<u8>> {
        motion(conn, x, y).layer_requests
    }

    fn move_message() -> WlMessage {
        message(LAYER, REQ_MOVE, &[word(SEAT), word(SERIAL)].concat())
    }

    fn resize_message(edges: u32) -> WlMessage {
        message(
            LAYER,
            REQ_RESIZE,
            &[word(SEAT), word(SERIAL), word(edges)].concat(),
        )
    }

    /// A converted window anchored to the top and left, with the pointer on it
    /// and a press the gesture may name.
    fn converted(anchor: u32) -> WaylandConn {
        *LAST_BUTTON.get_or_init(Default::default).lock().unwrap() = LastButtonState::default();
        GRABBED_IN.with(|has| has.set(START));
        let mut conn = connected();
        conn.layer_windows.insert(
            LAYER,
            LayerWindow {
                wl_surface: SURFACE,
                xdg_surface: 20,
                geometry: LayerGeometry {
                    width: 800,
                    height: 225,
                    margin_left: 40,
                    margin_top: 60,
                },
                bounds: None,
                output: None,
            },
        );
        conn.ifaces.insert(LAYER, Iface::ZwlrLayerSurface);
        conn.wl_to_layer.insert(SURFACE, LAYER);
        conn.surface_roles.insert(
            SURFACE,
            SurfaceRole::Layer(LayerShellOptions {
                anchor,
                ..super::super::super::test_support::options()
            }),
        );
        conn.pointer_focus.insert(POINTER, SURFACE);
        conn.pointer_seat.insert(POINTER, SEAT);
        conn.pointer_position
            .insert(POINTER, (ORIGIN.0 as i32, ORIGIN.1 as i32));
        let mut buttons = LAST_BUTTON.get().unwrap().lock().unwrap();
        buttons.by_surface.insert(
            (FD, SURFACE),
            LastButton {
                fd: FD,
                seat_id: SEAT,
                serial: SERIAL,
                wl_surface_id: SURFACE,
                x: ORIGIN.0 as i32,
                y: ORIGIN.1 as i32,
                button: BUTTON,
                at: Instant::now(),
            },
        );
        buttons.latest = Some((FD, SURFACE));
        conn
    }

    fn top_left() -> WaylandConn {
        converted(ANCHOR_TOP | ANCHOR_LEFT)
    }

    /// The same, with the screen's size known and the window named.
    fn on_a_screen(size: (u32, u32)) -> WaylandConn {
        let mut conn = top_left();
        conn.layer_windows.get_mut(&LAYER).unwrap().bounds = Some(size);
        conn.surface_ids.insert(SURFACE, "lyrics".to_string());
        conn
    }

    /// A listener that collects every push reported.
    fn pushes() -> std::sync::mpsc::Receiver<(String, u32)> {
        let (sender, receiver) = std::sync::mpsc::channel();
        assert!(super::super::super::state::on_layer_pushed(Box::new(
            move |window_id: String, edges: u32| {
                let _ = sender.send((window_id, edges));
            }
        )));
        receiver
    }

    fn geometry(conn: &WaylandConn) -> LayerGeometry {
        conn.layer_windows.get(&LAYER).unwrap().geometry
    }

    #[test]
    fn a_gesture_is_suppressed_and_never_reaches_the_compositor() {
        let _serial = serial();
        let mut conn = top_left();

        assert!(matches!(
            begin(FD, &mut conn, &move_message()),
            Action::Suppress
        ));
        assert!(conn.layer_grab.is_some());
    }

    #[test]
    fn a_move_follows_the_pointer_from_where_it_started() {
        let _serial = serial();
        let mut conn = top_left();
        begin(FD, &mut conn, &move_message());

        let requests = drag(&mut conn, (WORLD.0 + 16.0, WORLD.1 + 5.0)).layer_requests;

        // Margins are sent top, right, bottom, left, and the window is where
        // the pointer put it: the step is the pointer's own movement.
        assert_eq!(
            requests,
            vec![
                request(LAYER, REQ_LAYER_SET_MARGIN, 24, &[65, 0, 0, 56]),
                commit(),
            ]
        );
        assert_eq!(
            geometry(&conn),
            LayerGeometry {
                width: 800,
                height: 225,
                margin_left: 56,
                margin_top: 65,
            }
        );
    }

    #[test]
    fn a_motion_that_changed_nothing_asks_for_nothing() {
        let _serial = serial();
        let mut conn = top_left();
        begin(FD, &mut conn, &move_message());

        assert!(
            motion(&mut conn, ORIGIN.0, ORIGIN.1)
                .layer_requests
                .is_empty()
        );
        // A sub-pixel move rounds to the same margin, so nothing is sent —
        // which is what keeps a drag from writing on every motion event.
        assert!(
            motion(&mut conn, ORIGIN.0 + 0.4, ORIGIN.1)
                .layer_requests
                .is_empty()
        );
        assert!(
            !motion(&mut conn, ORIGIN.0 + 1.0, ORIGIN.1)
                .layer_requests
                .is_empty()
        );
    }

    /// What a drag is for: the pointer stays where it grabbed the window.
    ///
    /// The window moves with the pointer, so every step the pointer takes is
    /// also a step the window takes away from it. A step computed from where
    /// the gesture started carries that movement as if it were the pointer's,
    /// and the pointer drifts further out of the window with every event; a
    /// step computed from the window as it is now has that drift to undo and
    /// nothing else to do.
    #[test]
    fn a_long_drag_keeps_the_pointer_where_it_grabbed_the_window() {
        let _serial = serial();
        let mut conn = top_left();
        begin(FD, &mut conn, &move_message());

        for step in 1..=20 {
            let world = (WORLD.0 + step as f64 * 37.0, WORLD.1 + step as f64 * 11.0);
            drag(&mut conn, world);

            let geometry = geometry(&conn);
            assert_eq!(
                (
                    world.0 - geometry.margin_left as f64,
                    world.1 - geometry.margin_top as f64
                ),
                ORIGIN,
                "step {step} left the pointer somewhere else in the window"
            );
        }
    }

    /// A batch of motion events moves the window as far as the pointer moved.
    ///
    /// Every one of them carries a position measured from the same point — the
    /// one the press fixed — so a window dragged by "where the pointer is in it,
    /// less where it grabbed it" moves by the whole of that again on each event
    /// of the batch: eight events of ten pixels would carry it eighty short of
    /// the eighty they add up to, or rather eighty past it. This is the one
    /// that is worth counting.
    #[test]
    fn a_batch_of_motion_events_moves_the_window_once() {
        let _serial = serial();
        let mut conn = top_left();
        begin(FD, &mut conn, &move_message());

        for step in 1..=8 {
            drag(&mut conn, (WORLD.0 + step as f64 * 10.0, WORLD.1));
        }

        assert_eq!(geometry(&conn).margin_left, 40 + 80);
    }

    /// The window's own movement is not in the coordinates a drag reads.
    ///
    /// Which is the whole of why the emulation works: the window has been
    /// arranged somewhere else between two motion events, and the next event
    /// says nothing about that — it says where the pointer is, measured from
    /// where the press left it. A drag that took the window's position into
    /// account would count its own progress as the pointer's.
    #[test]
    fn where_a_window_has_been_dragged_to_is_not_in_the_next_position() {
        let _serial = serial();
        let mut conn = top_left();
        begin(FD, &mut conn, &move_message());

        // A step of the window's own, as if the compositor had arranged it.
        {
            let layer = conn.layer_windows.get_mut(&LAYER).unwrap();
            layer.geometry.margin_left += 300;
        }
        let requests = drag(&mut conn, (WORLD.0 + 10.0, WORLD.1)).layer_requests;

        // The pointer moved ten pixels, so the window does too — from where the
        // gesture found it, not from where it happens to be.
        assert_eq!(geometry(&conn).margin_left, 40 + 10);
        assert_eq!(
            requests.first(),
            Some(&request(LAYER, REQ_LAYER_SET_MARGIN, 24, &[60, 0, 0, 50])),
            "and the margin it is put at is written out whole"
        );
    }

    #[test]
    fn a_move_that_comes_back_lands_where_it_started() {
        let _serial = serial();
        let mut conn = top_left();
        begin(FD, &mut conn, &move_message());

        drag(&mut conn, (WORLD.0 + 300.0, WORLD.1 + 120.0));
        let requests = drag(&mut conn, WORLD).layer_requests;

        assert_eq!(
            requests,
            vec![
                request(LAYER, REQ_LAYER_SET_MARGIN, 24, &[60, 0, 0, 40]),
                commit(),
            ]
        );
        assert_eq!(geometry(&conn).margin_left, 40);
        assert_eq!(geometry(&conn).margin_top, 60);
    }

    #[test]
    fn a_resize_drags_only_the_edges_it_grabbed() {
        let _serial = serial();
        let mut conn = top_left();
        begin(FD, &mut conn, &resize_message(EDGE_RIGHT));

        let requests = requests(&mut conn, ORIGIN.0 + 50.0, ORIGIN.1 + 90.0);

        // Only the width follows a right-edge grab; the margins keep the
        // opposite corner where it was.
        assert_eq!(
            requests,
            vec![
                request(LAYER, REQ_LAYER_SET_SIZE, 16, &[850, 225]),
                commit(),
            ]
        );
    }

    #[test]
    fn a_top_left_resize_moves_the_margin_with_the_size() {
        let _serial = serial();
        let mut conn = top_left();
        begin(FD, &mut conn, &resize_message(EDGE_TOP | EDGE_LEFT));

        let requests = requests(&mut conn, ORIGIN.0 + 30.0, ORIGIN.1 + 25.0);

        // Both edges move together, and the size is sent before the margin.
        assert_eq!(
            requests,
            vec![
                request(LAYER, REQ_LAYER_SET_SIZE, 16, &[770, 200]),
                request(LAYER, REQ_LAYER_SET_MARGIN, 24, &[85, 0, 0, 70]),
                commit(),
            ]
        );
    }

    #[test]
    fn a_resize_stops_at_the_floor_and_takes_the_margin_with_it() {
        let _serial = serial();
        let mut conn = top_left();
        begin(FD, &mut conn, &resize_message(EDGE_LEFT));

        // Far past the smallest size the proxy will ask for.
        motion(&mut conn, ORIGIN.0 + 4000.0, ORIGIN.1);

        let applied = geometry(&conn);
        assert_eq!(applied.width, MIN_SIZE as u32);
        // The right edge is still at the margin the session started with.
        assert_eq!(applied.margin_left, 40 + 800 - MIN_SIZE);
    }

    #[test]
    fn a_drag_is_remembered_for_the_surfaces_next_role() {
        let _serial = serial();
        let mut conn = top_left();
        begin(FD, &mut conn, &move_message());

        drag(&mut conn, (WORLD.0 + 10.0, WORLD.1 + 5.0));

        // Hiding and showing a window builds a new role object, which is
        // converted from the cached options: a drag that is not in them is
        // undone by the next show.
        let Some(SurfaceRole::Layer(options)) = conn.surface_roles.get(&SURFACE) else {
            panic!("the window is a layer surface");
        };
        assert_eq!((options.width, options.height), (800, 225));
        assert_eq!((options.margin_left, options.margin_top), (50, 65));
    }

    #[test]
    fn a_drag_is_remembered_for_a_window_that_is_built_again() {
        let _serial = serial();
        // A window the application destroys and builds again under the same
        // managed id is converted from the policy, not from the surface.
        let mut conn = top_left();
        conn.surface_ids.insert(SURFACE, "lyrics".to_string());
        assert!(set_layer_policy(
            "lyrics",
            super::super::super::test_support::options()
        ));

        begin(FD, &mut conn, &move_message());
        drag(&mut conn, (WORLD.0 + 10.0, WORLD.1 + 5.0));
        on_pointer_button_release(&mut conn, POINTER, Some(BUTTON));

        let options = layer_policy("lyrics").expect("still registered");
        assert_eq!((options.margin_left, options.margin_top), (50, 65));
        clear_all_layer_policies();
    }

    #[test]
    fn a_finished_gesture_reports_where_the_window_ended_up() {
        let _serial = serial();
        let mut conn = top_left();
        conn.surface_ids.insert(SURFACE, "lyrics".to_string());
        let (sender, receiver) = std::sync::mpsc::channel();
        assert!(super::super::super::state::on_layer_geometry(Box::new(
            move |window_id: String, x: i32, y: i32, width: u32, height: u32| {
                // A listener that outlives its test simply stops receiving.
                let _ = sender.send((window_id, x, y, width, height));
            }
        )));

        begin(FD, &mut conn, &move_message());
        drag(&mut conn, (WORLD.0 + 10.0, WORLD.1 + 5.0));
        on_pointer_button_release(&mut conn, POINTER, Some(BUTTON));

        assert_eq!(
            receiver.try_recv().expect("the gesture is reported"),
            ("lyrics".to_string(), 50, 65, 800, 225)
        );
    }

    #[test]
    fn a_gesture_cannot_push_the_window_off_its_output() {
        let _serial = serial();
        let mut conn = on_a_screen((1280, 720));
        begin(FD, &mut conn, &move_message());

        // Far beyond the bottom right corner of the output it lives on.
        drag(&mut conn, (WORLD.0 + 4000.0, WORLD.1 + 4000.0));

        let applied = geometry(&conn);
        assert_eq!(
            applied.margin_left,
            1280 - 800,
            "the window ends where the screen does"
        );
        assert_eq!(applied.margin_top, 720 - 225);
    }

    #[test]
    fn a_gesture_cannot_push_the_window_out_of_the_top_left_either() {
        let _serial = serial();
        let mut conn = on_a_screen((1280, 720));
        begin(FD, &mut conn, &move_message());

        drag(&mut conn, (WORLD.0 - 4000.0, WORLD.1 - 4000.0));

        let applied = geometry(&conn);
        assert_eq!(applied.margin_left, 0);
        assert_eq!(applied.margin_top, 0);
    }

    /// The compositor's own answer about the output beats the one the
    /// application measured, and is the one a drag stops at when the two
    /// disagree.
    #[test]
    fn the_screens_size_comes_from_the_compositor_when_it_knows_it() {
        let _serial = serial();
        let mut conn = on_a_screen((2560, 1440));
        conn.outputs.insert(
            7,
            OutputInfo {
                logical_size: Some((1280, 720)),
                ..OutputInfo::default()
            },
        );
        conn.surface_outputs.insert(SURFACE, 7);
        begin(FD, &mut conn, &move_message());

        drag(&mut conn, (WORLD.0 + 4000.0, WORLD.1 + 4000.0));

        assert_eq!(geometry(&conn).margin_left, 1280 - 800);
        assert_eq!(geometry(&conn).margin_top, 720 - 225);
    }

    /// An output that has only just been announced reports no size, and a
    /// window held inside nothing would be pinned to a corner of the screen.
    #[test]
    fn an_output_that_reports_no_size_falls_back_to_the_reported_one() {
        let _serial = serial();
        let mut conn = on_a_screen((1280, 720));
        conn.outputs.insert(
            7,
            OutputInfo {
                logical_size: Some((0, 0)),
                ..OutputInfo::default()
            },
        );
        conn.surface_outputs.insert(SURFACE, 7);
        begin(FD, &mut conn, &move_message());

        drag(&mut conn, (WORLD.0 + 4000.0, WORLD.1));

        assert_eq!(geometry(&conn).margin_left, 1280 - 800);
    }

    #[test]
    fn a_window_larger_than_its_screen_is_left_alone() {
        let _serial = serial();
        let mut conn = top_left();
        {
            let layer = conn.layer_windows.get_mut(&LAYER).unwrap();
            // The smallest window a resize can leave, on an output barely
            // bigger than the strip that would have to stay inside it.
            layer.geometry = LayerGeometry {
                width: MIN_SIZE as u32,
                height: MIN_SIZE as u32,
                margin_left: 40,
                margin_top: 60,
            };
            layer.bounds = Some((10, 10));
        }
        GRABBED_IN.with(|has| has.set(geometry(&conn)));
        begin(FD, &mut conn, &move_message());

        // No margin puts a window that large on the screen, so it follows the
        // pointer rather than being pinned somewhere it does not belong.
        drag(&mut conn, (WORLD.0 + 40.0, WORLD.1 + 40.0));

        assert_eq!(geometry(&conn).margin_left, 80);
        assert_eq!(geometry(&conn).margin_top, 100);
    }

    #[test]
    fn pushing_past_an_edge_is_reported_when_the_button_comes_up() {
        let _serial = serial();
        let mut conn = on_a_screen((1280, 720));
        let receiver = pushes();

        // Dragged far past the right edge, until the pointer is out of the
        // window: only creating it again can move it any further. The button
        // press keeps the motion events coming, so this is where the push is
        // noticed — no leave, and nothing else to notice it by.
        begin(FD, &mut conn, &move_message());
        drag(&mut conn, (WORLD.0 + 4000.0, WORLD.1));
        assert!(
            conn.layer_grab.as_ref().is_some_and(|grab| grab.left),
            "the pointer is out of the window"
        );
        assert_eq!(
            geometry(&conn).margin_left,
            1280 - 800,
            "the window is held at the edge it cannot pass"
        );

        on_pointer_button_release(&mut conn, POINTER, Some(BUTTON));

        assert_eq!(
            receiver.try_recv().expect("the push is reported"),
            ("lyrics".to_string(), EDGE_RIGHT)
        );
    }

    #[test]
    fn a_pointer_that_comes_back_into_the_window_is_not_pushing_any_more() {
        let _serial = serial();
        let mut conn = on_a_screen((1280, 720));
        let receiver = pushes();

        begin(FD, &mut conn, &move_message());
        drag(&mut conn, (WORLD.0 + 4000.0, WORLD.1));
        // Dragged back until the window can follow the pointer again.
        drag(&mut conn, (WORLD.0 + 100.0, WORLD.1));
        on_pointer_button_release(&mut conn, POINTER, Some(BUTTON));

        assert!(
            receiver.try_recv().is_err(),
            "the window followed the pointer in the end"
        );
    }

    /// A second button pressed and released in the middle of a drag is not the
    /// drag ending: the gesture belongs to the button it was started with.
    #[test]
    fn a_button_the_gesture_was_not_started_with_does_not_end_it() {
        const OTHER_BUTTON: u32 = 0x111;
        let _serial = serial();
        let mut conn = on_a_screen((1280, 720));
        let receiver = pushes();

        begin(FD, &mut conn, &move_message());
        drag(&mut conn, (WORLD.0 + 4000.0, WORLD.1));

        assert!(
            !on_pointer_button_release(&mut conn, POINTER, Some(OTHER_BUTTON)),
            "the button the drag was not started with leaves it in flight"
        );
        assert!(conn.layer_grab.is_some());

        // And the drag it was started with goes on to its own ending.
        on_pointer_button_release(&mut conn, POINTER, Some(BUTTON));
        assert_eq!(
            receiver.try_recv().expect("the gesture is reported"),
            ("lyrics".to_string(), EDGE_RIGHT)
        );
    }

    #[test]
    fn a_drag_that_took_the_pointer_out_of_the_window_and_back_is_not_a_push() {
        let _serial = serial();
        let mut conn = on_a_screen((1280, 720));
        let receiver = pushes();

        begin(FD, &mut conn, &move_message());
        // Out of the window on the left, then to the middle of the screen: the
        // window follows the pointer to the end, so nothing was pushed off the
        // edge it lives on.
        drag(&mut conn, (WORLD.0 - 4000.0, WORLD.1));
        drag(&mut conn, (WORLD.0 + 400.0, WORLD.1));
        on_pointer_button_release(&mut conn, POINTER, Some(BUTTON));

        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn a_window_parked_at_the_edge_is_not_pushed_anywhere() {
        let _serial = serial();
        let mut conn = on_a_screen((1280, 720));
        let receiver = pushes();

        // Pushed to the edge and let go of there, with the pointer still on it:
        // that is where the user wanted the window, not a request to leave the
        // screen. How far the window can be pushed before its own edge is what
        // decides, and the window is 800 wide.
        begin(FD, &mut conn, &move_message());
        drag(&mut conn, (WORLD.0 + 500.0, WORLD.1));
        assert_eq!(geometry(&conn).margin_left, 1280 - 800, "at the edge");
        on_pointer_button_release(&mut conn, POINTER, Some(BUTTON));

        assert!(
            receiver.try_recv().is_err(),
            "the pointer never left the window"
        );
    }

    #[test]
    fn a_pointer_that_left_a_window_away_from_any_edge_reports_nothing() {
        let _serial = serial();
        let mut conn = on_a_screen((1280, 720));
        let receiver = pushes();

        begin(FD, &mut conn, &move_message());
        drag(&mut conn, (WORLD.0 + 10.0, WORLD.1 + 10.0));
        let mut fx = Effects::default();
        on_surface_left(&mut conn, &mut fx, SURFACE);
        on_pointer_button_release(&mut conn, POINTER, Some(BUTTON));

        assert!(
            receiver.try_recv().is_err(),
            "the window was nowhere near an edge, so nothing is asked for"
        );
    }

    #[test]
    fn a_resize_is_never_a_push() {
        let _serial = serial();
        let mut conn = on_a_screen((1280, 720));
        let receiver = pushes();

        // A resize that ends at the edge of the screen keeps the window's own
        // corner where it is: there is nothing to move anywhere. The pointer is
        // out of the window for the whole of a resize, which is what a move
        // would be read as.
        begin(FD, &mut conn, &resize_message(EDGE_RIGHT));
        motion(&mut conn, ORIGIN.0 + 4000.0, ORIGIN.1);
        let mut fx = Effects::default();
        on_surface_left(&mut conn, &mut fx, SURFACE);
        on_pointer_button_release(&mut conn, POINTER, Some(BUTTON));

        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn a_stale_serial_never_grabs() {
        let _serial = serial();
        let mut conn = top_left();

        let stale = message(LAYER, REQ_MOVE, &[word(SEAT), word(SERIAL + 1)].concat());
        assert!(matches!(begin(FD, &mut conn, &stale), Action::Suppress));
        assert!(conn.layer_grab.is_none(), "a gesture it cannot verify");
    }

    #[test]
    fn a_pointer_enter_serial_may_also_start_a_gesture() {
        let _serial = serial();
        let mut conn = top_left();
        conn.pointer_enter_serial.insert(SURFACE, SERIAL);

        let mut buttons = LAST_BUTTON.get().unwrap().lock().unwrap();
        buttons.by_surface.clear();
        buttons.latest = None;
        drop(buttons);

        begin(FD, &mut conn, &move_message());
        assert!(conn.layer_grab.is_some());
    }

    #[test]
    fn only_a_top_left_anchored_surface_can_be_driven() {
        let _serial = serial();
        // The coverage shape a background window uses: the compositor decides
        // where it sits, so there is no position to write.
        let mut conn = converted(super::super::super::layer_shell::ANCHOR_ALL);

        begin(FD, &mut conn, &move_message());

        assert!(conn.layer_grab.is_none());
    }

    #[test]
    fn a_gesture_on_a_window_the_pointer_is_not_over_is_refused() {
        let _serial = serial();
        let mut conn = top_left();
        conn.pointer_focus.clear();

        begin(FD, &mut conn, &move_message());

        assert!(conn.layer_grab.is_none());
    }

    #[test]
    fn a_press_and_a_gesture_named_by_another_seat_do_not_grab() {
        let _serial = serial();
        let mut conn = top_left();

        begin(
            FD,
            &mut conn,
            &message(LAYER, REQ_MOVE, &[word(SEAT + 1), word(SERIAL)].concat()),
        );

        assert!(conn.layer_grab.is_none());
    }

    #[test]
    fn releasing_the_button_ends_the_gesture() {
        let _serial = serial();
        let mut conn = top_left();
        begin(FD, &mut conn, &move_message());

        assert!(on_pointer_button_release(&mut conn, POINTER, Some(BUTTON)));
        assert!(
            motion(&mut conn, ORIGIN.0 + 50.0, ORIGIN.1)
                .layer_requests
                .is_empty()
        );
        assert!(
            !on_pointer_button_release(&mut conn, POINTER, Some(BUTTON)),
            "already over"
        );
    }

    #[test]
    fn without_the_screens_size_a_lost_window_comes_back() {
        let _serial = serial();
        let mut conn = top_left();
        begin(FD, &mut conn, &move_message());
        // Dragged far past the edge, with nothing to say where the edge is.
        drag(&mut conn, (WORLD.0 + 3000.0, WORLD.1));

        let mut fx = Effects::default();
        on_surface_left(&mut conn, &mut fx, SURFACE);

        assert!(conn.layer_grab.is_none());
        assert_eq!(
            fx.layer_requests,
            vec![
                request(LAYER, REQ_LAYER_SET_MARGIN, 24, &[60, 0, 0, 40]),
                commit(),
            ],
            "the window comes back to where the gesture found it"
        );
        assert_eq!(geometry(&conn).margin_left, 40);
    }

    #[test]
    fn a_pointer_that_merely_left_a_settled_window_changes_nothing() {
        let _serial = serial();
        let mut conn = top_left();

        let mut fx = Effects::default();
        on_surface_left(&mut conn, &mut fx, SURFACE);

        assert!(fx.layer_requests.is_empty(), "no gesture was in flight");
    }

    #[test]
    fn destroying_the_window_ends_the_gesture() {
        let _serial = serial();
        let mut conn = top_left();
        begin(FD, &mut conn, &move_message());

        conn.purge(LAYER);

        assert!(conn.layer_grab.is_none());
    }

    #[test]
    fn the_requests_use_layer_opcodes() {
        let _serial = serial();
        let mut conn = top_left();
        begin(FD, &mut conn, &move_message());

        // The reason these are injected straight to the compositor: on this id
        // the client's namespace reads opcode 0 as `destroy`, and `set_size` is
        // what the proxy sends.
        let requests = requests(&mut conn, ORIGIN.0 + 1.0, ORIGIN.1);
        let (object_id, opcode, size) = header(&requests[0]);
        assert_eq!(object_id, LAYER);
        assert_eq!((opcode, size), (REQ_LAYER_SET_MARGIN, 24));
        // …and the commit that makes it take effect is on the surface, not on
        // the layer object: it is a `wl_surface` request either way.
        assert_eq!(requests.last(), Some(&commit()));
    }
}
