//! Object-graph tracking: registry binds, surface/pointer/xdg creation,
//! destruction, and `delete_id` ID stealing.

use std::os::fd::RawFd;

use super::super::codec::{
    EVT_OUTPUT_DESCRIPTION, EVT_OUTPUT_GEOMETRY, EVT_OUTPUT_MODE, EVT_OUTPUT_NAME,
    EVT_OUTPUT_SCALE, EVT_POPUP_CONFIGURE, EVT_POPUP_DONE, EVT_SURFACE_ENTER, EVT_SURFACE_LEAVE,
    EVT_XDG_OUTPUT_LOGICAL_SIZE, EVT_XDG_OUTPUT_NAME, Iface, MODE_CURRENT, REQ_CREATE_POSITIONER,
    REQ_DESTROY, REQ_GET_POPUP, REQ_POSITIONER_SET_ANCHOR, REQ_POSITIONER_SET_ANCHOR_RECT,
    REQ_POSITIONER_SET_CONSTRAINT_ADJUSTMENT, REQ_POSITIONER_SET_GRAVITY, REQ_POSITIONER_SET_SIZE,
    REQ_SET_WINDOW_GEOMETRY, WlMessage,
};
use super::super::layer_shell::xdg_toplevel_configure;
use super::super::state::{
    LAST_BUTTON, PopupGeometry, PopupPolicy, SurfaceRole, WaylandConn, fire_layer_output,
    layer_bounds, layer_output_label, popup_policy, pull_inside_output, take_popup_policy,
};
use super::{Action, Effects, layer_note};

// xdg_positioner enums, distinct from layer-shell's anchor bitmask.
const POSITIONER_TOP_LEFT: i32 = 5;
const POSITIONER_BOTTOM_RIGHT: i32 = 8;
const POSITIONER_SLIDE_X: i32 = 1;
const POSITIONER_SLIDE_Y: i32 = 2;
const POSITIONER_FLIP_X: i32 = 4;
const POSITIONER_FLIP_Y: i32 = 8;

pub(crate) fn on_get_registry(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    if let Some(new_id) = msg.u32_arg(8) {
        conn.ifaces.insert(new_id, Iface::WlRegistry);
        conn.registry_id = Some(new_id);
    }
    Action::Forward
}

pub(crate) fn on_bind(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    if let Some((iface_name, after)) = msg.str_arg(12)
        && let Some(new_id) = msg.u32_arg(after + 4)
    {
        let tag = match iface_name {
            "wl_compositor" => {
                conn.compositor_id = Some(new_id);
                Some(Iface::WlCompositor)
            }
            "wl_seat" => Some(Iface::WlSeat),
            // Tracked for its name, which is how the application asks for the
            // output a window it re-creates should appear on.
            "wl_output" => {
                conn.outputs.entry(new_id).or_default();
                Some(Iface::WlOutput)
            }
            "zxdg_decoration_manager_v1" => Some(Iface::ZxdgDecorationManager),
            "xdg_toplevel_icon_manager_v1" => Some(Iface::XdgToplevelIconManager),
            "xdg_wm_base" => {
                conn.xdg_wm_base_id = Some(new_id);
                Some(Iface::XdgWmBase)
            }
            // The logical geometry of every output, which is the space a layer
            // surface's margins are measured in.
            "zxdg_output_manager_v1" => {
                conn.xdg_output_manager_id = Some(new_id);
                Some(Iface::ZxdgOutputManager)
            }
            _ => None,
        };
        if let Some(tag) = tag {
            conn.ifaces.insert(new_id, tag);
        }
    }
    Action::Forward
}

/// Events naming the output behind a `wl_output` the client bound.
///
/// Only the name and the description matter: they are what the application
/// knows an output by, and what a policy names when a window has to be created
/// on a particular one.
pub(crate) fn on_output_event(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    let Some(known) = conn.outputs.get_mut(&msg.object_id) else {
        return Action::Forward;
    };
    match msg.opcode {
        EVT_OUTPUT_GEOMETRY => {
            // `x, y, physical_width, physical_height, subpixel, make, model,
            // transform`: the two strings are the only variable-length part, so
            // the transform is wherever they leave off.
            if let Some((_, after_make)) = msg.str_arg(28)
                && let Some((_, after_model)) = msg.str_arg(after_make)
                && let Some(transform) = msg.u32_arg(after_model)
            {
                known.transform = Some(transform);
            }
        }
        EVT_OUTPUT_NAME => known.name = msg.str_arg(8).map(|(name, _)| name.to_string()),
        EVT_OUTPUT_DESCRIPTION => {
            known.description = msg.str_arg(8).map(|(text, _)| text.to_string())
        }
        EVT_OUTPUT_MODE => {
            // `flags, width, height, refresh`: the flags come first, and an
            // output advertises every mode it has — only the one it is in now
            // is the size it draws in.
            let flags = msg.u32_arg(8).unwrap_or(0);
            if flags & MODE_CURRENT != 0
                && let (Some(width), Some(height)) = (msg.u32_arg(12), msg.u32_arg(16))
            {
                known.mode = Some((width, height));
            }
        }
        EVT_OUTPUT_SCALE => known.scale = msg.u32_arg(8).map(|scale| scale as i32),
        _ => {}
    }
    Action::Forward
}

/// `zxdg_output_manager_v1.get_xdg_output(new_id, wl_output)`.
///
/// The object is the client's own view of one output's logical geometry; the
/// pair is kept so the size it reports can be filed against the output a
/// surface is on, which is the only place that size is worth having.
pub(crate) fn on_get_xdg_output(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    if let (Some(new_id), Some(output_id)) = (msg.u32_arg(8), msg.u32_arg(12)) {
        conn.ifaces.insert(new_id, Iface::ZxdgOutput);
        conn.xdg_outputs.insert(new_id, output_id);
    }
    Action::Forward
}

/// Events giving an output's logical geometry, or the name it is known by.
pub(crate) fn on_xdg_output_event(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    let Some(output_id) = conn.xdg_outputs.get(&msg.object_id).copied() else {
        return Action::Forward;
    };
    let Some(known) = conn.outputs.get_mut(&output_id) else {
        return Action::Forward;
    };
    match msg.opcode {
        EVT_XDG_OUTPUT_LOGICAL_SIZE => {
            if let (Some(width), Some(height)) = (msg.u32_arg(8), msg.u32_arg(12)) {
                known.logical_size = Some((width, height));
            }
        }
        EVT_XDG_OUTPUT_NAME => known.xdg_name = msg.str_arg(8).map(|(name, _)| name.to_string()),
        _ => {}
    }
    Action::Forward
}

/// `wl_surface.enter` and `wl_surface.leave`: which output a surface is on.
///
/// This is the only thing that ever says where a layer surface ended up: the
/// compositor chooses the output when it creates the surface, and nothing in
/// the protocol reports that choice afterwards. Without it a drag past the
/// screen edge could name no screen to put the window on.
pub(crate) fn on_surface_event(
    conn: &mut WaylandConn,
    msg: &WlMessage,
    fx: &mut Effects,
) -> Action {
    match msg.opcode {
        EVT_SURFACE_ENTER => {
            if let Some(output_id) = msg.u32_arg(8) {
                conn.surface_outputs.insert(msg.object_id, output_id);
                if let Some(layer_id) = conn.wl_to_layer.get(&msg.object_id).copied() {
                    let window_id = conn
                        .layer_windows
                        .get(&layer_id)
                        .and_then(|layer| conn.surface_ids.get(&layer.wl_surface))
                        .cloned();
                    let label = layer_output_label(conn, layer_id);
                    // Which screen a layer surface was given, and how large the
                    // proxy believes it is: the two things a drag against the
                    // edge of it is decided by.
                    layer_note(|| {
                        format!(
                            "{} is on output {:?} of size {:?}, window {}x{} at ({}, {})",
                            window_id.as_deref().unwrap_or("<unknown>"),
                            label.as_deref().unwrap_or("<unnamed>"),
                            layer_bounds(conn, layer_id),
                            conn.layer_windows
                                .get(&layer_id)
                                .map_or(0, |layer| layer.geometry.width),
                            conn.layer_windows
                                .get(&layer_id)
                                .map_or(0, |layer| layer.geometry.height),
                            conn.layer_windows
                                .get(&layer_id)
                                .map_or(0, |layer| layer.geometry.margin_left),
                            conn.layer_windows
                                .get(&layer_id)
                                .map_or(0, |layer| layer.geometry.margin_top),
                        )
                    });
                    if let (Some(window_id), Some(label)) = (window_id, label) {
                        fire_layer_output(&window_id, &label);
                    }
                    // A window that turned up outside this screen has no way
                    // back on its own, and this is the first moment the proxy
                    // can know both that and how large the screen is.
                    if let Some(requests) = pull_inside_output(conn, layer_id) {
                        layer_note(|| {
                            format!("{layer_id} was placed off its screen; pulling it back in")
                        });
                        fx.layer_requests.extend(requests);
                    }
                }
            }
        }
        EVT_SURFACE_LEAVE => {
            if let Some(output_id) = msg.u32_arg(8)
                && conn.surface_outputs.get(&msg.object_id) == Some(&output_id)
            {
                conn.surface_outputs.remove(&msg.object_id);
            }
        }
        _ => {}
    }
    Action::Forward
}

pub(crate) fn on_create_surface(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    if let Some(new_id) = msg.u32_arg(8) {
        conn.ifaces.insert(new_id, Iface::WlSurface);
    }
    Action::Forward
}

pub(crate) fn on_get_pointer(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    if let Some(new_id) = msg.u32_arg(8) {
        conn.ifaces.insert(new_id, Iface::WlPointer);
        conn.pointer_seat.insert(new_id, msg.object_id);
    }
    Action::Forward
}

pub(crate) fn on_get_touch(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    if let Some(new_id) = msg.u32_arg(8) {
        conn.ifaces.insert(new_id, Iface::WlTouch);
        conn.touch_seat.insert(new_id, msg.object_id);
    }
    Action::Forward
}

pub(crate) fn on_get_xdg_surface(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    if let (Some(xdg_id), Some(wl_id)) = (msg.u32_arg(8), msg.u32_arg(12)) {
        conn.ifaces.insert(xdg_id, Iface::XdgSurface);
        conn.xdg_to_wl.insert(xdg_id, wl_id);
    }
    Action::Forward
}

fn push_message(out: &mut Vec<u8>, object_id: u32, opcode: u16, args: &[i32]) {
    let size = 8 + args.len() * 4;
    out.extend_from_slice(&object_id.to_ne_bytes());
    out.extend_from_slice(&((opcode as u32) | ((size as u32) << 16)).to_ne_bytes());
    for arg in args {
        out.extend_from_slice(&arg.to_ne_bytes());
    }
}

pub(crate) fn on_get_toplevel(
    fd: RawFd,
    conn: &mut WaylandConn,
    msg: &WlMessage,
    fx: &mut Effects,
    window_id: Option<&str>,
) -> Action {
    if let Some(top_id) = msg.u32_arg(8) {
        // A window the application registered as a popup becomes one here, once
        // the decorated title has named it. Everything the positioner needs is
        // resolved at this point, so registering the intent could not fail for
        // want of a parent surface or an object id.
        if let Some(id) = window_id
            && let Some(policy) = popup_policy(id)
            && let Some(replacement) =
                build_popup_role(fd, conn, msg.object_id, top_id, &policy, fx)
        {
            take_popup_policy(id);
            return Action::Replace(vec![replacement]);
        }

        conn.ifaces.insert(top_id, Iface::XdgToplevel);
        conn.top_to_xdg.insert(top_id, msg.object_id);
        if let Some(wl_id) = conn.xdg_to_wl.get(&msg.object_id).copied() {
            conn.wl_to_top.insert(wl_id, top_id);
            // The surface is a toplevel for good: a compositor never releases
            // the role, so it can never become a layer surface. Keep any
            // refusal already reported for it.
            conn.surface_roles
                .entry(wl_id)
                .or_insert(SurfaceRole::Toplevel { reported: false });
            fx.arm_watchers_for.push(wl_id);
        }
    }
    Action::Forward
}

/// Replace `xdg_surface.get_toplevel` with the `xdg_popup` role the client's
/// window was registered for, or `None` to leave it an ordinary toplevel.
fn build_popup_role(
    fd: RawFd,
    conn: &mut WaylandConn,
    xdg_surface_id: u32,
    top_id: u32,
    policy: &PopupPolicy,
    fx: &mut Effects,
) -> Option<Vec<u8>> {
    let wm_base_id = conn.xdg_wm_base_id?;
    // The parent has to be on this connection, and a layer surface cannot be an
    // xdg_popup's xdg parent.
    let parent_wl_surface = conn
        .surface_ids
        .iter()
        .find_map(|(surface, id)| (id == &policy.parent_window_id).then_some(*surface))?;
    if matches!(
        conn.surface_roles.get(&parent_wl_surface),
        Some(SurfaceRole::Layer(_))
    ) {
        return None;
    }
    let parent_xdg_surface_id = conn
        .xdg_to_wl
        .iter()
        .find_map(|(xdg, wl)| (*wl == parent_wl_surface).then_some(*xdg))?;
    let (anchor_x, anchor_y) = match policy.anchor {
        Some(anchor) => anchor,
        None => {
            let button = LAST_BUTTON
                .get()
                .and_then(|v| v.lock().ok())
                .and_then(|v| v.by_surface.get(&(fd, parent_wl_surface)).copied())?;
            (button.x, button.y)
        }
    };
    let positioner_id = conn.alloc_injected_id()?;

    let geometry = PopupGeometry {
        inset: policy.shadow_inset,
        width: policy.width - policy.shadow_inset * 2,
        height: policy.height - policy.shadow_inset * 2,
    };
    let mut replacement = Vec::with_capacity(128);
    // xdg_wm_base.create_positioner(new_id)
    push_message(
        &mut replacement,
        wm_base_id,
        REQ_CREATE_POSITIONER,
        &[positioner_id as i32],
    );
    // xdg_positioner: size, anchor rect, anchor, gravity, constraints.
    push_message(
        &mut replacement,
        positioner_id,
        REQ_POSITIONER_SET_SIZE,
        &[geometry.width, geometry.height],
    );
    push_message(
        &mut replacement,
        positioner_id,
        REQ_POSITIONER_SET_ANCHOR_RECT,
        &[anchor_x, anchor_y, 1, 1],
    );
    push_message(
        &mut replacement,
        positioner_id,
        REQ_POSITIONER_SET_ANCHOR,
        &[POSITIONER_TOP_LEFT],
    );
    push_message(
        &mut replacement,
        positioner_id,
        REQ_POSITIONER_SET_GRAVITY,
        &[POSITIONER_BOTTOM_RIGHT],
    );
    push_message(
        &mut replacement,
        positioner_id,
        REQ_POSITIONER_SET_CONSTRAINT_ADJUSTMENT,
        &[POSITIONER_SLIDE_X | POSITIONER_SLIDE_Y | POSITIONER_FLIP_X | POSITIONER_FLIP_Y],
    );
    // xdg_surface.get_popup(new_id, parent, positioner)
    push_message(
        &mut replacement,
        xdg_surface_id,
        REQ_GET_POPUP,
        &[
            top_id as i32,
            parent_xdg_surface_id as i32,
            positioner_id as i32,
        ],
    );
    push_message(&mut replacement, positioner_id, REQ_DESTROY, &[]);
    // Position the menu itself, not the transparent shadow buffer.
    if geometry.inset > 0 {
        push_message(
            &mut replacement,
            xdg_surface_id,
            REQ_SET_WINDOW_GEOMETRY,
            &[
                geometry.inset,
                geometry.inset,
                geometry.width,
                geometry.height,
            ],
        );
        conn.popup_geometries.insert(xdg_surface_id, geometry);
    }

    conn.ifaces.insert(positioner_id, Iface::XdgPositioner);
    conn.ifaces.insert(top_id, Iface::XdgPopupShim);
    conn.top_to_xdg.insert(top_id, xdg_surface_id);
    if let Some(wl_id) = conn.xdg_to_wl.get(&xdg_surface_id).copied() {
        conn.wl_to_top.insert(wl_id, top_id);
        fx.arm_watchers_for.push(wl_id);
    }
    Some(replacement)
}

pub(crate) fn on_popup_geometry(conn: &WaylandConn, msg: &WlMessage) -> Action {
    let Some(geometry) = conn.popup_geometries.get(&msg.object_id) else {
        return Action::Forward;
    };
    let mut replacement = Vec::new();
    push_message(
        &mut replacement,
        msg.object_id,
        REQ_SET_WINDOW_GEOMETRY,
        &[
            geometry.inset,
            geometry.inset,
            geometry.width,
            geometry.height,
        ],
    );
    Action::Replace(vec![replacement])
}

pub(crate) fn on_popup_event(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    match msg.opcode {
        // Translate xdg_popup.configure(x, y, width, height) into the
        // xdg_toplevel.configure(width, height, states[]) Chromium expects.
        EVT_POPUP_CONFIGURE => {
            let (Some(width), Some(height)) = (msg.u32_arg(16), msg.u32_arg(20)) else {
                return Action::Suppress;
            };
            let inset = conn
                .top_to_xdg
                .get(&msg.object_id)
                .and_then(|xdg| conn.popup_geometries.get_mut(xdg))
                .map(|geometry| {
                    geometry.width = width as i32;
                    geometry.height = height as i32;
                    geometry.inset
                })
                .unwrap_or(0);
            Action::Replace(vec![xdg_toplevel_configure(
                msg.object_id,
                width as i32 + inset * 2,
                height as i32 + inset * 2,
            )])
        }
        EVT_POPUP_DONE => Action::Forward,
        _ => Action::Suppress,
    }
}

pub(crate) fn on_destroy(
    _fd: RawFd,
    conn: &mut WaylandConn,
    msg: &WlMessage,
    fx: &mut Effects,
) -> Action {
    if let Some(iface) = conn.ifaces.get(&msg.object_id).copied() {
        let wl_surface_id = conn.wl_surface_for_window_object(msg.object_id, iface);
        if let Some(wl_surface_id) = wl_surface_id {
            fx.destroyed_surfaces.push(wl_surface_id);
        }
    }
    conn.purge(msg.object_id);
    Action::Forward
}

pub(crate) fn on_pointer_release(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    conn.purge(msg.object_id);
    Action::Forward
}

pub(crate) fn on_touch_release(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    conn.purge(msg.object_id);
    Action::Forward
}

pub(crate) fn on_delete_id(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    if let Some(dead) = msg.u32_arg(8) {
        // If it's one of our injected IDs, we're done with it — recycle it.
        if conn.injected_ids.remove(&dead) {
            // Unless the client still owns a shadow object under this id (a
            // decoration whose compositor-side resource was a throwaway): its
            // requests must keep being intercepted, and the id must not be
            // handed out again while it lives.
            if conn.ifaces.get(&dead) == Some(&Iface::ZxdgToplevelDecoration) {
                return Action::Suppress;
            }
            // A reserved id: the client owns an object under it that the
            // compositor was never allowed to create, and this is the callback
            // that reserved it being consumed. The id is the client's, never
            // ours — recycling it would hand the same id to both sides at once.
            if let Some(reservation) = conn.reservations.get_mut(&dead) {
                reservation.callback_done = true;
                if reservation.client_done {
                    // The client is already done with its object, so this answer
                    // is exactly the release it is waiting for.
                    conn.reservations.remove(&dead);
                    return Action::Forward;
                }
                // The client is still using it. The events of the callback are
                // hidden until it answers, which it just did; the release waits
                // for the client's own destroy.
                return Action::Suppress;
            }
            conn.purge(dead);
            conn.stolen_ids.push(dead);
            return Action::Suppress;
        }

        conn.purge(dead);

        // Otherwise steal up to 32 deleted IDs from the client for our own use.
        // Reserve a small pool of compositor-confirmed client IDs for injected
        // region/positioner objects. Arbitrary fresh IDs are not accepted by
        // every Wayland compositor.
        if conn.stolen_ids.contains(&dead) {
            // Keep reserved IDs hidden from the client without recycling twice.
            return Action::Suppress;
        }
        if conn.stolen_ids.len() < 32 {
            conn.stolen_ids.push(dead);
            return Action::Suppress;
        }
    }
    Action::Forward
}

#[cfg(test)]
mod output_tests {
    use super::super::super::codec::{
        EVT_OUTPUT_MODE, EVT_OUTPUT_SCALE, EVT_SURFACE_ENTER, EVT_SURFACE_LEAVE,
        EVT_XDG_OUTPUT_LOGICAL_SIZE, EVT_XDG_OUTPUT_NAME, Iface, REQ_BIND, REQ_COMMIT,
        REQ_GET_XDG_OUTPUT, REQ_LAYER_SET_MARGIN,
    };
    use super::super::super::state::{LayerGeometry, LayerWindow, OutputInfo, output_for_name};
    use super::super::super::test_support::{message, request, wl_string, word};
    use super::*;

    /// A connection with one named output, and a converted window on it.
    fn window_on(output: u32) -> WaylandConn {
        let mut conn = WaylandConn::new();
        conn.outputs.insert(
            output,
            OutputInfo {
                name: Some("DP-2".into()),
                ..OutputInfo::default()
            },
        );
        conn.ifaces.insert(10, Iface::WlSurface);
        conn.ifaces.insert(30, Iface::ZwlrLayerSurface);
        conn.wl_to_layer.insert(10, 30);
        conn.surface_ids.insert(10, "lyrics".into());
        conn.layer_windows.insert(
            30,
            LayerWindow {
                wl_surface: 10,
                xdg_surface: 20,
                geometry: LayerGeometry {
                    width: 800,
                    height: 225,
                    margin_left: 0,
                    margin_top: 0,
                },
                bounds: None,
                output: None,
            },
        );
        conn
    }

    #[test]
    fn a_surface_says_which_output_the_window_landed_on() {
        let (sender, receiver) = std::sync::mpsc::channel();
        assert!(super::super::super::state::on_layer_output(Box::new(
            move |window_id: String, output: String| {
                let _ = sender.send((window_id, output));
            }
        )));

        let mut conn = window_on(7);
        let entered = message(10, EVT_SURFACE_ENTER, &word(7));
        assert!(matches!(
            on_surface_event(&mut conn, &entered, &mut Effects::default()),
            Action::Forward
        ));

        // The application is told in the proxy's own name for the output, so
        // it can hand that name straight back when it wants a window there.
        assert_eq!(
            receiver.try_recv().expect("the output is reported"),
            ("lyrics".to_string(), "DP-2".to_string())
        );
        let left = message(10, EVT_SURFACE_LEAVE, &word(7));
        on_surface_event(&mut conn, &left, &mut Effects::default());
        assert_eq!(conn.surface_outputs.get(&10), None);
    }

    /// A client that made no `zxdg_output_v1` for an output still tells the
    /// proxy how large it draws: the mode it is running, and how many of those
    /// pixels go into one logical one.
    #[test]
    fn an_output_without_a_logical_size_is_measured_by_its_mode() {
        let mut conn = WaylandConn::new();
        conn.outputs.insert(7, OutputInfo::default());
        // A mode the output has, but is not in: the flags come first, and this
        // one is not the size it is drawing in.
        on_output_event(
            &mut conn,
            &message(
                7,
                EVT_OUTPUT_MODE,
                &[word(0), word(3840), word(2160), word(60_000)].concat(),
            ),
        );
        assert_eq!(conn.outputs.get(&7).unwrap().size(), None);
        on_output_event(
            &mut conn,
            &message(
                7,
                EVT_OUTPUT_MODE,
                &[word(MODE_CURRENT), word(3840), word(2160), word(60_000)].concat(),
            ),
        );
        on_output_event(&mut conn, &message(7, EVT_OUTPUT_SCALE, &word(2)));

        // Rounded down, so the window is held inside the screen rather than
        // somewhere the far edge of a screen that is not there.
        assert_eq!(conn.outputs.get(&7).unwrap().size(), Some((1920, 1080)));

        // Standing on its side: the mode is still the landscape one the panel
        // was made with, and the screen a client draws into is the other way
        // round — its geometry is `x, y, physical size, subpixel, make, model,
        // transform`, so the transform rides after two strings.
        let placement = [word(0), word(0), word(600), word(340), word(0)].concat();
        on_output_event(
            &mut conn,
            &message(
                7,
                EVT_OUTPUT_GEOMETRY,
                &[
                    placement,
                    wl_string("Acme"),
                    wl_string("Portrait 9000"),
                    word(1),
                ]
                .concat(),
            ),
        );
        assert_eq!(conn.outputs.get(&7).unwrap().size(), Some((1080, 1920)));

        // And what the client says itself wins where there is one.
        conn.xdg_outputs.insert(70, 7);
        on_xdg_output_event(
            &mut conn,
            &message(
                70,
                EVT_XDG_OUTPUT_LOGICAL_SIZE,
                &[word(1707), word(960)].concat(),
            ),
        );
        assert_eq!(conn.outputs.get(&7).unwrap().size(), Some((1707, 960)));
    }

    /// A placement is margins from one screen's corner, so a window created
    /// with another screen's is nowhere near the one it landed on. Nothing else
    /// can bring it back: it is off the screen and out of the pointer's reach.
    #[test]
    fn a_window_placed_on_another_screens_corner_is_pulled_back_into_view() {
        let mut conn = window_on(7);
        conn.outputs.insert(
            7,
            OutputInfo {
                logical_size: Some((1280, 720)),
                ..OutputInfo::default()
            },
        );
        {
            // Placed against the right edge of a screen twice this size.
            let layer = conn.layer_windows.get_mut(&30).unwrap();
            layer.geometry.margin_left = 2560 - 24;
            layer.geometry.margin_top = 40;
        }

        let entered = message(10, EVT_SURFACE_ENTER, &word(7));
        let mut fx = Effects::default();
        on_surface_event(&mut conn, &entered, &mut fx);

        assert_eq!(
            fx.layer_requests,
            vec![
                request(30, REQ_LAYER_SET_MARGIN, 24, &[40, 0, 0, 1280 - 800]),
                request(10, REQ_COMMIT, 8, &[]),
            ],
            "the window is held wholly on the screen it is on"
        );
        let layer = conn.layer_windows.get(&30).unwrap();
        assert_eq!(layer.geometry.margin_left, 1280 - 800);
    }

    #[test]
    fn the_clients_own_view_of_an_output_names_it_and_sizes_it() {
        let mut conn = WaylandConn::new();
        conn.outputs.insert(7, OutputInfo::default());
        let bound = message(5, REQ_BIND, &{
            let mut args = word(1);
            args.extend_from_slice(&wl_string("zxdg_output_manager_v1"));
            args.extend_from_slice(&word(3));
            args.extend_from_slice(&word(2));
            args
        });
        assert!(matches!(on_bind(&mut conn, &bound), Action::Forward));
        assert_eq!(conn.xdg_output_manager_id, Some(2));
        assert_eq!(conn.ifaces.get(&2), Some(&Iface::ZxdgOutputManager));

        let made = message(2, REQ_GET_XDG_OUTPUT, &[word(70), word(7)].concat());
        on_get_xdg_output(&mut conn, &made);
        assert_eq!(conn.xdg_outputs.get(&70), Some(&7));

        on_xdg_output_event(
            &mut conn,
            &message(70, EVT_XDG_OUTPUT_NAME, &wl_string("DP-2")),
        );
        on_xdg_output_event(
            &mut conn,
            &message(
                70,
                EVT_XDG_OUTPUT_LOGICAL_SIZE,
                &[word(2560), word(1440)].concat(),
            ),
        );

        // The name a toolkit builds its display label from, and the size the
        // window's margins are measured in.
        assert_eq!(output_for_name(&conn, "DP-2"), Some(7));
        let known = conn.outputs.get(&7).unwrap();
        assert_eq!(known.logical_size, Some((2560, 1440)));
        assert_eq!(known.label().as_deref(), Some("DP-2"));
    }
}

#[cfg(test)]
mod deleted_id_tests {
    use super::super::super::test_support::message;
    use super::*;

    fn recycle(conn: &mut WaylandConn, msg: &WlMessage) -> Action {
        on_delete_id(conn, msg)
    }

    #[test]
    fn a_reserved_id_is_not_recycled_twice_or_returned_to_the_client() {
        let mut conn = WaylandConn::new();
        let deleted = message(1, 1, &42_u32.to_ne_bytes());
        assert!(matches!(recycle(&mut conn, &deleted), Action::Suppress));
        assert!(matches!(recycle(&mut conn, &deleted), Action::Suppress));
        assert_eq!(conn.stolen_ids, vec![42]);
    }

    #[test]
    fn a_full_pool_still_suppresses_duplicates_but_forwards_new_ids() {
        let mut conn = WaylandConn::new();
        conn.stolen_ids = (10..42).collect();
        let duplicate = message(1, 1, &10_u32.to_ne_bytes());
        assert!(matches!(recycle(&mut conn, &duplicate), Action::Suppress));
        let new_id = message(1, 1, &42_u32.to_ne_bytes());
        assert!(matches!(recycle(&mut conn, &new_id), Action::Forward));
        assert_eq!(conn.stolen_ids.len(), 32);
    }
}

#[cfg(test)]
mod popup_shadow_tests {
    use super::super::super::test_support::{message, request};
    use super::*;

    #[test]
    fn positioner_uses_content_size_and_preserves_the_anchor() {
        use super::super::super::{
            codec::{REQ_GET_TOPLEVEL, decode},
            state,
        };
        state::init_state();
        let fd = 94_101;
        state::clear_runtime_state_for_fd(fd);
        state::insert_popup_policy_for_test(
            fd,
            "shadow-menu",
            "shadow-parent",
            280,
            329,
            24,
            Some((70, 80)),
        );
        let mut conn = WaylandConn::new();
        conn.xdg_wm_base_id = Some(2);
        // The parent the policy names has to be resolvable on this connection.
        conn.surface_ids.insert(20, "shadow-parent".into());
        conn.xdg_to_wl.insert(19, 20);
        conn.stolen_ids.push(900);
        let msg = WlMessage::new(
            40,
            REQ_GET_TOPLEVEL,
            request(40, REQ_GET_TOPLEVEL, 12, &[50]),
        );
        let Action::Replace(out) = on_get_toplevel(
            fd,
            &mut conn,
            &msg,
            &mut Effects::default(),
            Some("shadow-menu"),
        ) else {
            panic!("popup not converted")
        };
        let (messages, _) = decode(&out.concat());
        let size = messages
            .iter()
            .find(|m| m.object_id == 900 && m.opcode == 1)
            .unwrap();
        assert_eq!(size.raw(), request(900, 1, 16, &[232, 281]));
        let anchor = messages
            .iter()
            .find(|m| m.object_id == 900 && m.opcode == 2)
            .unwrap();
        assert_eq!(anchor.raw(), request(900, 2, 24, &[70, 80, 1, 1]));
        let geometry = messages
            .iter()
            .find(|m| m.object_id == 40 && m.opcode == REQ_SET_WINDOW_GEOMETRY)
            .unwrap();
        assert_eq!(
            geometry.raw(),
            request(40, REQ_SET_WINDOW_GEOMETRY, 24, &[24, 24, 232, 281])
        );
        state::clear_runtime_state_for_fd(fd);
    }

    fn padded_connection() -> WaylandConn {
        let mut conn = WaylandConn::new();
        conn.ifaces.insert(40, Iface::XdgSurface);
        conn.ifaces.insert(50, Iface::XdgPopupShim);
        conn.ifaces.insert(10, Iface::WlSurface);
        conn.xdg_to_wl.insert(40, 10);
        conn.top_to_xdg.insert(50, 40);
        conn.popup_geometries.insert(
            40,
            PopupGeometry {
                inset: 24,
                width: 232,
                height: 281,
            },
        );
        conn
    }

    #[test]
    fn geometry_excludes_shadow_and_configure_restores_buffer_size() {
        let mut conn = padded_connection();
        let raw = request(40, 3, 24, &[0, 0, 280, 329]);
        let msg = WlMessage::new(40, 3, raw);
        let Action::Replace(out) = on_popup_geometry(&conn, &msg) else {
            panic!("geometry not rewritten")
        };
        assert_eq!(out, vec![request(40, 3, 24, &[24, 24, 232, 281])]);
        let configure = WlMessage::new(50, 0, request(50, 0, 24, &[10, 20, 232, 281]));
        let Action::Replace(out) = on_popup_event(&mut conn, &configure) else {
            panic!("configure not translated")
        };
        assert_eq!(out, vec![request(50, 0, 20, &[280, 329, 0])]);
        // Non-popup windows must retain their original geometry.
        assert!(matches!(
            on_popup_geometry(&conn, &message(41, 3, &[])),
            Action::Forward
        ));
    }

    #[test]
    fn shadow_state_dies_with_role_surface_and_connection() {
        for id in [10, 40, 50] {
            let mut conn = padded_connection();
            conn.purge(id);
            assert!(conn.popup_geometries.is_empty(), "object {id}");
        }
        let mut conn = padded_connection();
        conn.reset_tracking();
        assert!(conn.popup_geometries.is_empty());
    }
}
