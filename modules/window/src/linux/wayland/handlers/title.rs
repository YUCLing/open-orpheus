//! `set_title` interception.
//!
//! The application never writes a bare title: `ManagedWindow` decorates it as
//! `prefix + managed window id + separator + real title`. The id is the native
//! layer's name for the window and stays attached to the surface for as long as
//! the surface lives; the real title is the only part the compositor ever sees.

use std::os::fd::RawFd;

use super::super::codec::{REQ_SET_TITLE, WlMessage, parse_custom_title};
use super::super::state::{CUSTOM_ID_MAP, WaylandConn};
use super::Action;

/// `xdg_toplevel.set_title(title)`, rebuilt without the id.
fn set_title(object_id: u32, title: &str) -> Vec<u8> {
    let bytes = title.as_bytes();
    // A wayland string is a length word (including the NUL), then the bytes and
    // the NUL, padded to a word boundary.
    let padded = (bytes.len() + 1).next_multiple_of(4);
    let mut body = Vec::with_capacity(4 + padded);
    body.extend_from_slice(&((bytes.len() + 1) as u32).to_ne_bytes());
    body.extend_from_slice(bytes);
    body.resize(4 + padded, 0);

    let size = 8 + body.len();
    let mut message = Vec::with_capacity(size);
    message.extend_from_slice(&object_id.to_ne_bytes());
    message.extend_from_slice(&(((size as u32) << 16) | REQ_SET_TITLE as u32).to_ne_bytes());
    message.extend_from_slice(&body);
    message
}

pub(crate) fn on_set_title(fd: RawFd, conn: &mut WaylandConn, msg: &WlMessage) -> Action {
    let Some(title) = msg.str_text(8) else {
        return Action::Forward;
    };
    let Some((managed_id, real_title)) = parse_custom_title(title) else {
        // A title the application did not decorate (a page title that raced the
        // decoration): the id is already known for this surface, so forward it.
        return Action::Forward;
    };

    // Works for ordinary toplevels and for windows the proxy converted to layer
    // surfaces, which the client still addresses as toplevels.
    if let Some(wl_surf) = conn.toplevel_wl_surface(msg.object_id)
        && let Some(m) = CUSTOM_ID_MAP.get()
        && let Ok(mut map) = m.lock()
    {
        map.insert(managed_id.to_string(), (fd, wl_surf));
    }

    Action::Replace(vec![set_title(msg.object_id, real_title)])
}

#[cfg(test)]
mod tests {
    use super::super::super::codec::decorate_title;
    use super::*;

    fn header(buf: &[u8]) -> (u32, u16, usize) {
        let packed = u32::from_ne_bytes(buf[4..8].try_into().unwrap());
        (
            u32::from_ne_bytes(buf[0..4].try_into().unwrap()),
            (packed & 0xFFFF) as u16,
            (packed >> 16) as usize,
        )
    }

    #[test]
    fn a_decorated_title_is_rewritten_without_the_id() {
        let message = set_title(31, "Now Playing");
        assert_eq!(header(&message), (31, REQ_SET_TITLE, 24));

        // length word, then the string and its NUL, then padding to a word.
        let len = u32::from_ne_bytes(message[8..12].try_into().unwrap());
        assert_eq!(len, "Now Playing".len() as u32 + 1);
        assert_eq!(&message[12..12 + "Now Playing".len()], b"Now Playing");
        assert_eq!(message.len() % 4, 0);
    }

    #[test]
    fn an_empty_real_title_is_still_a_valid_message() {
        let message = set_title(31, "");
        assert_eq!(header(&message), (31, REQ_SET_TITLE, 16));
        assert_eq!(&message[8..12], &1u32.to_ne_bytes());
    }

    #[test]
    fn a_title_with_multibyte_characters_keeps_the_right_length() {
        let message = set_title(31, "曲名");
        assert_eq!(header(&message), (31, REQ_SET_TITLE, 20));
        let len = u32::from_ne_bytes(message[8..12].try_into().unwrap());
        assert_eq!(len, "曲名".len() as u32 + 1);
        assert_eq!(&message[12..12 + "曲名".len()], "曲名".as_bytes());
    }

    #[test]
    fn the_decoration_round_trips_through_parse_and_rewrite() {
        let decorated = decorate_title("4711", "Real Title");
        assert_eq!(parse_custom_title(&decorated), Some(("4711", "Real Title")));
        let rewritten = set_title(9, "Real Title");
        assert_eq!(&rewritten[12..12 + "Real Title".len()], b"Real Title");
    }
}
