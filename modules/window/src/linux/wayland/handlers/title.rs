//! `set_title` interception: user-assigned window IDs smuggled via
//! `setTitle("\u{200B}\u{200C}<id>")`.

use std::os::fd::RawFd;

use super::super::codec::{CUSTOM_ID_PREFIX, WlMessage};
use super::super::state::{CUSTOM_ID_MAP, WaylandConn};
use super::Action;

pub(crate) fn on_set_title(fd: RawFd, conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    if let Some(title) = msg.str_text(8)
        && let Some(custom_id) = title.strip_prefix(CUSTOM_ID_PREFIX)
    {
        // Works for ordinary toplevels and for windows the proxy converted to
        // layer surfaces, which the client still addresses as toplevels.
        let wl_surf = conn.toplevel_wl_surface(msg.object_id);

        if let Some(wl_surf) = wl_surf
            && let Some(m) = CUSTOM_ID_MAP.get()
            && let Ok(mut map) = m.lock()
        {
            map.insert(custom_id.to_string(), (fd, wl_surf));
        }
        return Action::Suppress;
    }
    Action::Forward
}
