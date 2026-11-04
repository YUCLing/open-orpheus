//! `wl_output` registry, keyed the way Electron names displays.
//!
//! Chromium builds its display cache from `wl_registry.global` and
//! `global_remove`, and the `name` argument of each global is the `Display.id`
//! the application sees. A layer surface's output is fixed when its role is
//! created, so a window that has to appear on a particular display needs that
//! display's `wl_output` object at role-creation time.
//!
//! Keeping the two together here means the application can hand back a
//! `Display.id` it already knows, and the role conversion can resolve it to the
//! object the client bound for that output. The registry is per connection
//! because global names are scoped to one `wl_display`.

use super::state::WaylandConn;

/// The interface name the compositor advertises an output under.
pub(crate) const INTERFACE: &str = "wl_output";

/// Record an output the compositor advertised.
///
/// The name is the `wl_registry` global name, which is also the `Display.id`
/// Electron reports. Repeating the announcement keeps any objects already
/// bound; only [`withdrawn`] starts an output over.
pub(crate) fn advertised(conn: &mut WaylandConn, name: u32) {
    conn.outputs.entry(name).or_default();
}

/// Forget an output the compositor withdrew.
///
/// The client may still hold `wl_output` objects for it until it destroys
/// them, but those no longer name an output that can be placed on.
pub(crate) fn withdrawn(conn: &mut WaylandConn, name: u32) {
    conn.outputs.remove(&name);
}

/// Remember that the client bound a `wl_output` object for an output.
///
/// More than one object per output is legal, so every bind is kept until the
/// object is destroyed.
pub(crate) fn bound(conn: &mut WaylandConn, name: u32, object_id: u32) {
    let output = conn.outputs.entry(name).or_default();
    if !output.objects.contains(&object_id) {
        output.objects.push(object_id);
    }
}

/// Forget a `wl_output` object the client destroyed.
///
/// Called when `wl_output.release` is forwarded, before the compositor answers
/// with `delete_id`: the id cannot be named in between, and a layer surface
/// created there would otherwise point at a destroyed object.
pub(crate) fn destroyed(conn: &mut WaylandConn, object_id: u32) {
    for output in conn.outputs.values_mut() {
        output.objects.retain(|id| *id != object_id);
    }
}

/// Record the compositor's name for the output a `wl_output` object belongs to.
///
/// The name arrives on the object, not the registry, so it is filed against the
/// output that object was bound for. An object the proxy never recorded (for
/// example one from before a resync) has no output to name, and is ignored.
pub(crate) fn named(conn: &mut WaylandConn, object_id: u32, name: &str) {
    for output in conn.outputs.values_mut() {
        if output.objects.contains(&object_id) {
            output.name = Some(name.to_string());
            return;
        }
    }
}

/// The client's `wl_output` object for a `Display.id`, if it bound one.
///
/// The layer-role conversion consumes this when a policy names an output; the
/// registry keeps the mapping so that decision has one owner.
pub(crate) fn object_for(conn: &WaylandConn, display_id: u32) -> Option<u32> {
    conn.outputs.get(&display_id)?.objects.first().copied()
}

#[cfg(test)]
mod tests {
    use super::super::codec::Iface;
    use super::*;

    #[test]
    fn an_advertised_output_is_keyed_by_its_display_id() {
        let mut conn = WaylandConn::new();

        advertised(&mut conn, 77);

        assert!(
            conn.outputs
                .get(&77)
                .is_some_and(|output| output.objects.is_empty())
        );
        assert_eq!(object_for(&conn, 77), None, "nothing is bound yet");
    }

    #[test]
    fn a_bound_output_is_resolvable_by_its_display_id() {
        let mut conn = WaylandConn::new();
        advertised(&mut conn, 77);

        bound(&mut conn, 77, 900);

        assert_eq!(object_for(&conn, 77), Some(900));
        assert_eq!(conn.outputs[&77].objects, vec![900]);
        assert_eq!(object_for(&conn, 78), None, "another display has none");
    }

    #[test]
    fn a_name_is_filed_against_the_output_that_bound_the_object() {
        let mut conn = WaylandConn::new();
        advertised(&mut conn, 77);
        advertised(&mut conn, 78);
        bound(&mut conn, 77, 900);
        bound(&mut conn, 78, 901);

        named(&mut conn, 900, "DP-1");

        assert_eq!(conn.outputs[&77].name.as_deref(), Some("DP-1"));
        assert_eq!(conn.outputs[&78].name, None, "another output is untouched");

        // An object the registry does not know has no output to name.
        named(&mut conn, 999, "unknown");
        assert_eq!(conn.outputs[&77].name.as_deref(), Some("DP-1"));
    }

    #[test]
    fn an_output_keeps_its_name_after_the_object_that_reported_it_goes() {
        let mut conn = WaylandConn::new();
        advertised(&mut conn, 77);
        bound(&mut conn, 77, 900);
        named(&mut conn, 900, "DP-1");
        conn.ifaces.insert(900, Iface::WlOutput);

        conn.purge(900);

        assert_eq!(conn.outputs[&77].name.as_deref(), Some("DP-1"));
        assert_eq!(object_for(&conn, 77), None);
    }

    #[test]
    fn a_bind_is_remembered_even_before_the_global_is_tracked() {
        // The registry must survive a lost `global` event as well as a normal
        // one: the bind message itself names the display id and the object.
        let mut conn = WaylandConn::new();

        bound(&mut conn, 77, 900);

        assert_eq!(object_for(&conn, 77), Some(900));
    }

    #[test]
    fn every_bind_is_kept_once_in_bind_order() {
        let mut conn = WaylandConn::new();
        advertised(&mut conn, 77);

        bound(&mut conn, 77, 900);
        bound(&mut conn, 77, 901);
        bound(&mut conn, 77, 900);

        assert_eq!(conn.outputs[&77].objects, vec![900, 901]);
        assert_eq!(object_for(&conn, 77), Some(900), "the first live object");
    }

    #[test]
    fn withdrawing_an_output_forgets_the_objects_bound_for_it() {
        let mut conn = WaylandConn::new();
        advertised(&mut conn, 77);
        bound(&mut conn, 77, 900);

        withdrawn(&mut conn, 77);

        assert!(!conn.outputs.contains_key(&77));
        assert_eq!(object_for(&conn, 77), None);

        // A global name is reusable. The new output starts without the objects
        // the old one had.
        advertised(&mut conn, 77);
        assert_eq!(object_for(&conn, 77), None);
        bound(&mut conn, 77, 901);
        assert_eq!(object_for(&conn, 77), Some(901));
    }

    #[test]
    fn destroying_one_object_leaves_the_output_and_its_other_objects() {
        let mut conn = WaylandConn::new();
        advertised(&mut conn, 77);
        bound(&mut conn, 77, 900);
        bound(&mut conn, 77, 901);
        conn.ifaces.insert(900, Iface::WlOutput);
        conn.ifaces.insert(901, Iface::WlOutput);

        conn.purge(900);

        assert!(conn.outputs.contains_key(&77), "the output is still there");
        assert_eq!(conn.outputs[&77].objects, vec![901]);
        assert_eq!(object_for(&conn, 77), Some(901));

        conn.purge(901);
        assert_eq!(object_for(&conn, 77), None);
        assert!(conn.outputs.contains_key(&77));
    }

    #[test]
    fn resetting_a_connection_forgets_the_registry() {
        let mut conn = WaylandConn::new();
        advertised(&mut conn, 77);
        bound(&mut conn, 77, 900);

        conn.reset_tracking();

        assert!(conn.outputs.is_empty());
        assert_eq!(object_for(&conn, 77), None);
    }
}
