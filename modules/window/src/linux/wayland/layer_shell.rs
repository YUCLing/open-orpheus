//! `zwlr_layer_shell_v1` support for the Wayland proxy.
//!
//! A converted window is presented to the compositor as a layer surface while
//! the client keeps speaking xdg-shell. This module owns the option model, the
//! validity rules the protocol imposes, and the wire messages the proxy emits
//! or synthesises on the client's behalf.

use super::codec::{
    EVT_DECORATION_CONFIGURE, EVT_TOPLEVEL_CLOSE, EVT_TOPLEVEL_CONFIGURE, REQ_BIND,
    REQ_GET_LAYER_SURFACE, REQ_LAYER_ACK_CONFIGURE, REQ_LAYER_DESTROY, REQ_LAYER_GET_POPUP,
    REQ_LAYER_SET_ANCHOR, REQ_LAYER_SET_EXCLUSIVE_ZONE, REQ_LAYER_SET_KEYBOARD_INTERACTIVITY,
    REQ_LAYER_SET_MARGIN, REQ_LAYER_SET_SIZE,
};

/// The interface name the layer-shell global is advertised under.
pub(crate) const INTERFACE: &str = "zwlr_layer_shell_v1";

/// Highest layer-shell version whose features this proxy uses.
///
/// Versions above it are still bound (the server's advertised version wins);
/// this only gates capability decisions such as `on_demand` keyboard focus.
pub(crate) const SUPPORTED_VERSION: u32 = 4;

/// `zwlr_layer_surface_v1.keyboard_interactivity.on_demand` exists from here.
const ON_DEMAND_SINCE_VERSION: u32 = 4;

// ── Enumerations ───────────────────────────────────────────────────────────

pub(crate) const LAYER_BACKGROUND: u32 = 0;
pub(crate) const LAYER_BOTTOM: u32 = 1;
pub(crate) const LAYER_TOP: u32 = 2;
pub(crate) const LAYER_OVERLAY: u32 = 3;

pub(crate) const ANCHOR_TOP: u32 = 1;
pub(crate) const ANCHOR_BOTTOM: u32 = 2;
pub(crate) const ANCHOR_LEFT: u32 = 4;
pub(crate) const ANCHOR_RIGHT: u32 = 8;
pub(crate) const ANCHOR_ALL: u32 = ANCHOR_TOP | ANCHOR_BOTTOM | ANCHOR_LEFT | ANCHOR_RIGHT;

pub(crate) const KEYBOARD_NONE: u32 = 0;
pub(crate) const KEYBOARD_EXCLUSIVE: u32 = 1;
pub(crate) const KEYBOARD_ON_DEMAND: u32 = 2;

/// Longest namespace accepted; compositors may impose their own limits.
const MAX_NAMESPACE_LEN: usize = 32;

// ── Options ────────────────────────────────────────────────────────────────

/// The layer surface state applied when a window is created.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LayerShellOptions {
    pub(crate) namespace: String,
    pub(crate) layer: u32,
    pub(crate) anchor: u32,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) margin_top: i32,
    pub(crate) margin_right: i32,
    pub(crate) margin_bottom: i32,
    pub(crate) margin_left: i32,
    pub(crate) exclusive_zone: i32,
    pub(crate) keyboard_interactivity: u32,
}

impl Default for LayerShellOptions {
    fn default() -> Self {
        Self {
            namespace: String::new(),
            layer: LAYER_TOP,
            anchor: 0,
            width: 0,
            height: 0,
            margin_top: 0,
            margin_right: 0,
            margin_bottom: 0,
            margin_left: 0,
            exclusive_zone: 0,
            keyboard_interactivity: KEYBOARD_NONE,
        }
    }
}

impl LayerShellOptions {
    /// Apply the one default that makes an otherwise empty declaration valid.
    ///
    /// A surface asking for a size of `0` on an axis has to anchor both opposite
    /// edges there, so a declaration with neither a size nor an anchor would be
    /// a protocol error. Saying nothing at all is taken to mean "cover the
    /// output": all four anchors with the compositor picking the size.
    pub(crate) fn with_defaults(mut self) -> Self {
        if self.width == 0 && self.height == 0 && self.anchor == 0 {
            self.anchor = ANCHOR_ALL;
        }
        self
    }

    /// Reject state the compositor would answer with a protocol error.
    ///
    /// A protocol error kills the application's whole display connection, so
    /// anything doubtful is refused here instead of being sent.
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.namespace.is_empty() {
            return Err("namespace must not be empty");
        }
        if self.namespace.len() > MAX_NAMESPACE_LEN {
            return Err("namespace is longer than 32 bytes");
        }
        match self.layer {
            LAYER_BACKGROUND | LAYER_BOTTOM | LAYER_TOP | LAYER_OVERLAY => {}
            _ => return Err("layer is out of range"),
        }
        if self.anchor & !ANCHOR_ALL != 0 {
            return Err("anchor has unknown bits");
        }
        let horizontal = ANCHOR_LEFT | ANCHOR_RIGHT;
        let vertical = ANCHOR_TOP | ANCHOR_BOTTOM;
        if self.width == 0 && self.anchor & horizontal != horizontal {
            return Err("width 0 needs both left and right anchors");
        }
        if self.height == 0 && self.anchor & vertical != vertical {
            return Err("height 0 needs both top and bottom anchors");
        }
        if self.keyboard_interactivity > KEYBOARD_ON_DEMAND {
            return Err("keyboard interactivity is out of range");
        }
        Ok(())
    }

    /// The keyboard mode to request on a layer shell of `version`.
    ///
    /// `on_demand` only exists from version 4; older compositors get the
    /// closest thing they understand.
    pub(crate) fn effective_keyboard(&self, version: u32) -> u32 {
        if version < ON_DEMAND_SINCE_VERSION && self.keyboard_interactivity == KEYBOARD_ON_DEMAND {
            return KEYBOARD_EXCLUSIVE;
        }
        self.keyboard_interactivity
    }
}

// ── Wire encoding ──────────────────────────────────────────────────────────

fn message(object_id: u32, opcode: u16, body: &[u8]) -> Vec<u8> {
    debug_assert_eq!(body.len() % 4, 0, "wayland bodies are word aligned");
    let size = 8 + body.len();
    let mut buf = Vec::with_capacity(size);
    buf.extend_from_slice(&object_id.to_ne_bytes());
    buf.extend_from_slice(&(((size as u32) << 16) | opcode as u32).to_ne_bytes());
    buf.extend_from_slice(body);
    buf
}

fn push_u32(buf: &mut Vec<u8>, value: u32) {
    buf.extend_from_slice(&value.to_ne_bytes());
}

fn push_i32(buf: &mut Vec<u8>, value: i32) {
    buf.extend_from_slice(&value.to_ne_bytes());
}

/// A wayland string: length including the NUL, bytes, NUL, padded to 4 bytes.
fn push_string(buf: &mut Vec<u8>, text: &str) {
    push_u32(buf, (text.len() + 1) as u32);
    buf.extend_from_slice(text.as_bytes());
    buf.push(0);
    while !buf.len().is_multiple_of(4) {
        buf.push(0);
    }
}

/// `wl_registry.bind(name, interface, version, id)`.
pub(crate) fn bind(registry_id: u32, global_name: u32, version: u32, new_id: u32) -> Vec<u8> {
    let mut body = Vec::new();
    push_u32(&mut body, global_name);
    push_string(&mut body, INTERFACE);
    push_u32(&mut body, version);
    push_u32(&mut body, new_id);
    message(registry_id, REQ_BIND, &body)
}

/// `zwlr_layer_shell_v1.get_layer_surface(id, surface, output, layer, namespace)`.
pub(crate) fn get_layer_surface(
    shell_id: u32,
    new_id: u32,
    surface_id: u32,
    layer: u32,
    namespace: &str,
) -> Vec<u8> {
    let mut body = Vec::new();
    push_u32(&mut body, new_id);
    push_u32(&mut body, surface_id);
    // A null output lets the compositor pick the most recently used one.
    push_u32(&mut body, 0);
    push_u32(&mut body, layer);
    push_string(&mut body, namespace);
    message(shell_id, REQ_GET_LAYER_SURFACE, &body)
}

/// `zwlr_layer_surface_v1.set_size(width, height)`.
pub(crate) fn set_size(layer_id: u32, width: u32, height: u32) -> Vec<u8> {
    let mut body = Vec::new();
    push_u32(&mut body, width);
    push_u32(&mut body, height);
    message(layer_id, REQ_LAYER_SET_SIZE, &body)
}

/// `zwlr_layer_surface_v1.set_anchor(anchor)`.
pub(crate) fn set_anchor(layer_id: u32, anchor: u32) -> Vec<u8> {
    let mut body = Vec::new();
    push_u32(&mut body, anchor);
    message(layer_id, REQ_LAYER_SET_ANCHOR, &body)
}

/// `zwlr_layer_surface_v1.set_exclusive_zone(zone)`.
pub(crate) fn set_exclusive_zone(layer_id: u32, zone: i32) -> Vec<u8> {
    let mut body = Vec::new();
    push_i32(&mut body, zone);
    message(layer_id, REQ_LAYER_SET_EXCLUSIVE_ZONE, &body)
}

/// `zwlr_layer_surface_v1.set_margin(top, right, bottom, left)`.
pub(crate) fn set_margin(layer_id: u32, margins: [i32; 4]) -> Vec<u8> {
    let mut body = Vec::new();
    for value in margins {
        push_i32(&mut body, value);
    }
    message(layer_id, REQ_LAYER_SET_MARGIN, &body)
}

/// `zwlr_layer_surface_v1.set_keyboard_interactivity(mode)`.
pub(crate) fn set_keyboard_interactivity(layer_id: u32, mode: u32) -> Vec<u8> {
    let mut body = Vec::new();
    push_u32(&mut body, mode);
    message(layer_id, REQ_LAYER_SET_KEYBOARD_INTERACTIVITY, &body)
}

/// `zwlr_layer_surface_v1.ack_configure(serial)`.
pub(crate) fn ack_configure(layer_id: u32, serial: u32) -> Vec<u8> {
    let mut body = Vec::new();
    push_u32(&mut body, serial);
    message(layer_id, REQ_LAYER_ACK_CONFIGURE, &body)
}

/// `zwlr_layer_surface_v1.destroy()`.
pub(crate) fn destroy(layer_id: u32) -> Vec<u8> {
    message(layer_id, REQ_LAYER_DESTROY, &[])
}

/// `zwlr_layer_surface_v1.get_popup(popup)`.
pub(crate) fn get_popup(layer_id: u32, popup_id: u32) -> Vec<u8> {
    let mut body = Vec::new();
    push_u32(&mut body, popup_id);
    message(layer_id, REQ_LAYER_GET_POPUP, &body)
}

/// A copy of a `xdg_surface.get_popup` request whose parent is nulled out.
///
/// A layer surface can only parent a popup through
/// `zwlr_layer_surface_v1.get_popup`, so the xdg-shell parent (which the
/// compositor never saw a role for) is replaced with null.
pub(crate) fn strip_popup_parent(raw: &[u8]) -> Option<Vec<u8>> {
    // header (8) + id (4) then the parent object argument.
    let mut rewritten = raw.to_vec();
    let parent = 8 + 4;
    rewritten
        .get_mut(parent..parent + 4)?
        .copy_from_slice(&0u32.to_ne_bytes());
    Some(rewritten)
}

/// `xdg_toplevel.configure(width, height, states)` with no states.
pub(crate) fn xdg_toplevel_configure(toplevel_id: u32, width: i32, height: i32) -> Vec<u8> {
    let mut body = Vec::new();
    push_i32(&mut body, width);
    push_i32(&mut body, height);
    push_u32(&mut body, 0); // an empty states array
    message(toplevel_id, EVT_TOPLEVEL_CONFIGURE, &body)
}

/// `xdg_surface.configure(serial)`.
pub(crate) fn xdg_surface_configure(xdg_surface_id: u32, serial: u32) -> Vec<u8> {
    let mut body = Vec::new();
    push_u32(&mut body, serial);
    message(xdg_surface_id, 0, &body)
}

/// `xdg_toplevel.close()`.
pub(crate) fn xdg_toplevel_close(toplevel_id: u32) -> Vec<u8> {
    message(toplevel_id, EVT_TOPLEVEL_CLOSE, &[])
}

/// `zxdg_toplevel_decoration_v1.configure(mode)`.
pub(crate) fn decoration_configure(decoration_id: u32, mode: u32) -> Vec<u8> {
    let mut body = Vec::new();
    push_u32(&mut body, mode);
    message(decoration_id, EVT_DECORATION_CONFIGURE, &body)
}

/// `wl_display.sync(id)`, used to reserve an object id.
///
/// A `new_id` the proxy suppresses would otherwise leave a hole in the
/// compositor's object map at the edge it is still growing, and the next id the
/// client allocates is then refused ("not a valid new object id"). Creating and
/// immediately discarding a callback keeps the map dense.
pub(crate) fn sync_callback(new_id: u32) -> Vec<u8> {
    let mut body = Vec::new();
    push_u32(&mut body, new_id);
    message(1, 0, &body)
}

#[cfg(test)]
mod tests {
    use super::super::codec::REQ_GET_POPUP;
    use super::*;

    fn header(buf: &[u8]) -> (u32, u16, usize) {
        (
            u32::from_ne_bytes(buf[0..4].try_into().unwrap()),
            (u32::from_ne_bytes(buf[4..8].try_into().unwrap()) & 0xFFFF) as u16,
            (u32::from_ne_bytes(buf[4..8].try_into().unwrap()) >> 16) as usize,
        )
    }

    #[test]
    fn sizes_and_opcodes_match_the_protocol() {
        assert_eq!(header(&destroy(7)), (7, REQ_LAYER_DESTROY, 8));
        assert_eq!(header(&set_size(7, 1, 2)), (7, REQ_LAYER_SET_SIZE, 16));
        assert_eq!(header(&set_anchor(7, 15)), (7, REQ_LAYER_SET_ANCHOR, 12));
        assert_eq!(
            header(&set_exclusive_zone(7, -1)),
            (7, REQ_LAYER_SET_EXCLUSIVE_ZONE, 12)
        );
        assert_eq!(
            header(&set_margin(7, [1, 2, 3, 4])),
            (7, REQ_LAYER_SET_MARGIN, 24)
        );
        assert_eq!(
            header(&set_keyboard_interactivity(7, KEYBOARD_ON_DEMAND)),
            (7, REQ_LAYER_SET_KEYBOARD_INTERACTIVITY, 12)
        );
        assert_eq!(
            header(&ack_configure(7, 42)),
            (7, REQ_LAYER_ACK_CONFIGURE, 12)
        );
        assert_eq!(header(&get_popup(7, 9)), (7, REQ_LAYER_GET_POPUP, 12));
        assert_eq!(
            header(&xdg_toplevel_configure(5, 300, 200)),
            (5, EVT_TOPLEVEL_CONFIGURE, 20)
        );
        assert_eq!(header(&xdg_surface_configure(4, 42)), (4, 0, 12));
        assert_eq!(header(&xdg_toplevel_close(5)), (5, EVT_TOPLEVEL_CLOSE, 8));
    }

    #[test]
    fn bind_carries_the_interface_and_version() {
        let bytes = bind(1, 63, 5, 500);
        let (oid, op, size) = header(&bytes);
        assert_eq!((oid, op), (1, REQ_BIND));
        assert_eq!(size, bytes.len());
        assert_eq!(u32::from_ne_bytes(bytes[8..12].try_into().unwrap()), 63);
        let len = u32::from_ne_bytes(bytes[12..16].try_into().unwrap()) as usize;
        assert_eq!(len, INTERFACE.len() + 1);
        assert_eq!(&bytes[16..16 + INTERFACE.len()], INTERFACE.as_bytes());
        assert_eq!(bytes[16 + INTERFACE.len()], 0);
        let version_at = 16 + len.next_multiple_of(4);
        assert_eq!(
            u32::from_ne_bytes(bytes[version_at..version_at + 4].try_into().unwrap()),
            5
        );
        assert_eq!(
            u32::from_ne_bytes(bytes[version_at + 4..version_at + 8].try_into().unwrap()),
            500
        );
    }

    #[test]
    fn get_layer_surface_pads_the_namespace() {
        let bytes = get_layer_surface(9, 30, 10, LAYER_OVERLAY, "wl");
        let (oid, op, size) = header(&bytes);
        assert_eq!((oid, op), (9, REQ_GET_LAYER_SURFACE));
        assert_eq!(size % 4, 0);
        assert_eq!(size, bytes.len());
        assert_eq!(u32::from_ne_bytes(bytes[8..12].try_into().unwrap()), 30);
        assert_eq!(u32::from_ne_bytes(bytes[12..16].try_into().unwrap()), 10);
        assert_eq!(u32::from_ne_bytes(bytes[16..20].try_into().unwrap()), 0);
        assert_eq!(
            u32::from_ne_bytes(bytes[20..24].try_into().unwrap()),
            LAYER_OVERLAY
        );
        assert_eq!(u32::from_ne_bytes(bytes[24..28].try_into().unwrap()), 3);
        assert_eq!(&bytes[28..30], b"wl");
        assert_eq!(bytes[30], 0);
        assert_eq!(bytes[31], 0, "the string is padded to a word");
    }

    #[test]
    fn popup_parents_are_nulled_in_place() {
        let mut body = Vec::new();
        push_u32(&mut body, 99);
        push_u32(&mut body, 77);
        push_u32(&mut body, 55);
        let raw = message(11, REQ_GET_POPUP, &body);

        let stripped = strip_popup_parent(&raw).unwrap();
        assert_eq!(stripped.len(), raw.len());
        assert_eq!(u32::from_ne_bytes(stripped[8..12].try_into().unwrap()), 99);
        assert_eq!(u32::from_ne_bytes(stripped[12..16].try_into().unwrap()), 0);
        assert_eq!(u32::from_ne_bytes(stripped[16..20].try_into().unwrap()), 55);
        assert_eq!(strip_popup_parent(&[]), None);
    }

    #[test]
    fn validation_rejects_state_the_compositor_would_error_on() {
        let base = LayerShellOptions {
            namespace: "test".into(),
            anchor: ANCHOR_TOP | ANCHOR_BOTTOM | ANCHOR_LEFT | ANCHOR_RIGHT,
            ..Default::default()
        };
        assert_eq!(base.validate(), Ok(()));

        for layer in [LAYER_BACKGROUND, LAYER_BOTTOM, LAYER_TOP, LAYER_OVERLAY] {
            let options = LayerShellOptions {
                layer,
                ..base.clone()
            };
            assert_eq!(options.validate(), Ok(()), "layer {layer} is valid");
        }

        assert!(
            LayerShellOptions::default().validate().is_err(),
            "namespace"
        );

        let bad_layer = LayerShellOptions {
            layer: 4,
            ..base.clone()
        };
        assert!(bad_layer.validate().is_err());

        let bad_anchor = LayerShellOptions {
            anchor: 16,
            ..base.clone()
        };
        assert!(bad_anchor.validate().is_err());

        let zero_width = LayerShellOptions {
            anchor: ANCHOR_TOP,
            width: 0,
            height: 100,
            ..base.clone()
        };
        assert!(zero_width.validate().is_err());
        let zero_height = LayerShellOptions {
            anchor: ANCHOR_LEFT,
            width: 100,
            height: 0,
            ..base.clone()
        };
        assert!(zero_height.validate().is_err());

        let bad_keyboard = LayerShellOptions {
            keyboard_interactivity: 3,
            ..base.clone()
        };
        assert!(bad_keyboard.validate().is_err());

        let long_namespace = LayerShellOptions {
            namespace: "x".repeat(33),
            ..base
        };
        assert!(long_namespace.validate().is_err());
    }

    #[test]
    fn an_empty_declaration_defaults_to_covering_the_output() {
        let empty = LayerShellOptions {
            namespace: "test".into(),
            ..Default::default()
        };
        let filled = empty.with_defaults();
        assert_eq!(filled.anchor, ANCHOR_ALL);
        assert_eq!((filled.width, filled.height), (0, 0));
        assert_eq!(filled.validate(), Ok(()));

        // Being explicit about either keeps the caller in charge.
        let sized = LayerShellOptions {
            namespace: "test".into(),
            width: 800,
            height: 225,
            ..Default::default()
        };
        assert_eq!(sized.with_defaults().anchor, 0);

        let anchored = LayerShellOptions {
            namespace: "test".into(),
            anchor: ANCHOR_TOP,
            ..Default::default()
        };
        let anchored = anchored.with_defaults();
        assert_eq!(anchored.anchor, ANCHOR_TOP, "no anchors are invented");
        assert!(
            anchored.validate().is_err(),
            "width 0 still needs both horizontal anchors"
        );
    }

    #[test]
    fn on_demand_keyboard_falls_back_before_version_four() {
        let options = LayerShellOptions {
            namespace: "test".into(),
            keyboard_interactivity: KEYBOARD_ON_DEMAND,
            ..Default::default()
        };
        assert_eq!(options.effective_keyboard(4), KEYBOARD_ON_DEMAND);
        assert_eq!(options.effective_keyboard(5), KEYBOARD_ON_DEMAND);
        assert_eq!(options.effective_keyboard(3), KEYBOARD_EXCLUSIVE);
        assert_eq!(options.effective_keyboard(1), KEYBOARD_EXCLUSIVE);

        let none = LayerShellOptions {
            namespace: "test".into(),
            ..Default::default()
        };
        assert_eq!(none.effective_keyboard(1), KEYBOARD_NONE);
    }
}
