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
        let xdg_id = conn.top_to_xdg.get(&msg.object_id).copied();
        let wl_surf = xdg_id.and_then(|xid| conn.xdg_to_wl.get(&xid).copied());

        if let Some(wl_surf) = wl_surf
            && let Some(m) = CUSTOM_ID_MAP.get()
            && let Ok(mut map) = m.lock()
        {
            map.retain(|_, mapped| *mapped != (fd, wl_surf));
            map.insert(custom_id.to_string(), (fd, wl_surf));
        }
        return Action::Suppress;
    }
    Action::Forward
}
