use quick_xml::{Reader, events::Event};

/// Parsed representation of the `<Default name="Menu">` entry from `menu/skin.xml`.
///
/// Only the subset of DUI attributes needed to render menus is supported.
/// All lengths are in logical pixels. Colors are in egui's [`egui::Color32`].
#[derive(Clone, Debug)]
pub struct MenuSkin {
    pub max_width: f32,
    pub min_width: f32,
    /// inset: `[top, left, bottom, right]` logical pixel padding inside the window.
    /// Parsed from the DUI `top,left,bottom,right` order, e.g. `"12,16,12,16"` → top=12, left=16.
    pub inset: [f32; 4],
    /// Nine-patch background image URI and corner sizes [left, top, right, bottom].
    pub bk_image: Option<NinePatch>,
    /// Tiled hover-highlight image URI.
    pub item_hot_image: Option<String>,
    /// Background color for disabled items (egui Color32).
    pub item_disabled_bk_color: Option<egui::Color32>,
}

#[derive(Clone, Debug)]
pub struct NinePatch {
    /// Skin-pack-relative path, e.g. `menu/bk.png`.
    #[allow(dead_code)]
    pub path: String,
    /// Nine-patch corner sizes: [left, top, right, bottom].
    #[allow(dead_code)]
    pub corner: [f32; 4],
}

impl Default for MenuSkin {
    fn default() -> Self {
        Self {
            max_width: 195.0,
            min_width: 186.0,
            inset: [12.0, 16.0, 12.0, 16.0], // top=12, left=16, bottom=12, right=16
            bk_image: None,
            item_hot_image: None,
            item_disabled_bk_color: None,
        }
    }
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

/// Parse `menu/skin.xml` bytes and return a `MenuSkin`.
/// Falls back to defaults for any attribute that is missing or unparsable.
pub fn parse_menu_skin(xml: &[u8]) -> MenuSkin {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(true);

    loop {
        match reader.read_event() {
            Ok(Event::Empty(ref e)) | Ok(Event::Start(ref e))
                if e.name().as_ref() == b"Default" =>
            {
                let mut is_menu = false;
                let mut value_str: Option<String> = None;

                for attr in e.attributes().flatten() {
                    match attr.key.as_ref() {
                        b"name" => {
                            if attr.unescape_value().ok().as_deref() == Some("Menu") {
                                is_menu = true;
                            }
                        }
                        b"value" => {
                            // unescape_value() resolves &quot; and other XML entities.
                            if let Ok(v) = attr.unescape_value() {
                                value_str = Some(v.into_owned());
                            }
                        }
                        _ => {}
                    }
                }

                if is_menu {
                    return value_str
                        .as_deref()
                        .map(parse_dui_attrs)
                        .unwrap_or_default();
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }

    MenuSkin::default()
}

/// Parse a DUI-style space-separated `key="value"` attribute string.
///
/// The value string looks like:
/// `maxwidth="195" minwidth="186" inset="12,16,12,16" bkimage="file='menu/bk.png' corner='16,20,16,20'" …`
///
/// Sub-values use single-quotes, so we track single-quote nesting to avoid
/// splitting on a `"` that is inside a single-quoted region.
fn parse_dui_attrs(attrs: &str) -> MenuSkin {
    let mut skin = MenuSkin::default();

    let mut pos = 0;
    let bytes = attrs.as_bytes();

    while pos < attrs.len() {
        // Skip whitespace
        while pos < attrs.len() && matches!(bytes[pos], b' ' | b'\t' | b'\n' | b'\r') {
            pos += 1;
        }
        if pos >= attrs.len() {
            break;
        }

        // Read key up to '='
        let key_start = pos;
        while pos < attrs.len() && bytes[pos] != b'=' {
            pos += 1;
        }
        if pos >= attrs.len() {
            break;
        }
        let key = attrs[key_start..pos].trim();
        pos += 1; // skip '='

        // Read value — double-quoted, may contain single-quoted sub-values
        if pos >= attrs.len() || bytes[pos] != b'"' {
            break;
        }
        pos += 1; // skip opening '"'
        let val_start = pos;
        let mut in_single = false;
        while pos < attrs.len() {
            match bytes[pos] {
                b'\'' => {
                    in_single = !in_single;
                    pos += 1;
                }
                b'"' if !in_single => break,
                _ => {
                    pos += 1;
                }
            }
        }
        let val = &attrs[val_start..pos];
        pos += 1; // skip closing '"'

        match key {
            "maxwidth" => {
                if let Ok(v) = val.parse::<f32>() {
                    skin.max_width = v;
                }
            }
            "minwidth" => {
                if let Ok(v) = val.parse::<f32>() {
                    skin.min_width = v;
                }
            }
            "inset" => {
                skin.inset = parse_quad(val).unwrap_or(skin.inset);
            }
            "bkimage" => {
                if let Some(path) = extract_single_quoted(val, "file") {
                    let corner = extract_single_quoted(val, "corner")
                        .and_then(parse_quad)
                        .unwrap_or([0.0; 4]);
                    skin.bk_image = Some(NinePatch {
                        path: path.to_owned(),
                        corner,
                    });
                }
            }
            "itemhotimage" => {
                if let Some(path) = extract_single_quoted(val, "file") {
                    skin.item_hot_image = Some(path.to_owned());
                } else if !val.is_empty() {
                    skin.item_hot_image = Some(val.to_owned());
                }
            }
            "itemdisabledbkcolor" => {
                skin.item_disabled_bk_color = parse_argb_color(val);
            }
            _ => {}
        }
    }

    skin
}

/// Parse a `key='value'` sub-attribute from a DUI value string.
fn extract_single_quoted<'a>(s: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("{}='", key);
    let start = s.find(needle.as_str())? + needle.len();
    let end = s[start..].find('\'')? + start;
    Some(&s[start..end])
}

/// Parse `"N,N,N,N"` into `[f32; 4]`.
fn parse_quad(s: &str) -> Option<[f32; 4]> {
    let mut parts = s.splitn(4, ',');
    let a = parts.next()?.trim().parse().ok()?;
    let b = parts.next()?.trim().parse().ok()?;
    let c = parts.next()?.trim().parse().ok()?;
    let d = parts.next()?.trim().parse().ok()?;
    Some([a, b, c, d])
}

/// Parse an ARGB hex color string `#AARRGGBB` into [`egui::Color32`].
fn parse_argb_color(s: &str) -> Option<egui::Color32> {
    let s = s.trim_start_matches('#');
    if s.len() == 8 {
        let v = u32::from_str_radix(s, 16).ok()?;
        let a = ((v >> 24) & 0xFF) as u8;
        let r = ((v >> 16) & 0xFF) as u8;
        let g = ((v >> 8) & 0xFF) as u8;
        let b = (v & 0xFF) as u8;
        Some(egui::Color32::from_rgba_unmultiplied(r, g, b, a))
    } else if s.len() == 6 {
        let v = u32::from_str_radix(s, 16).ok()?;
        let r = ((v >> 16) & 0xFF) as u8;
        let g = ((v >> 8) & 0xFF) as u8;
        let b = (v & 0xFF) as u8;
        Some(egui::Color32::from_rgb(r, g, b))
    } else {
        None
    }
}

// ─── Element Templates ────────────────────────────────────────────────────────

/// A node in the layout tree parsed from an `element_*.xml` file.
///
/// The tree mirrors the DOM one-to-one, so the renderer is fully general:
/// any nesting depth, any container element names, any future schema changes
/// all work as long as `<Button>` elements appear in the correct order.
#[derive(Clone, Debug)]
pub enum LayoutNode {
    /// `<HorizontalLayout>` — arranges children left-to-right.
    Horizontal(Vec<LayoutNode>),
    /// `<VerticalLayout>` — arranges children top-to-bottom.
    Vertical(Vec<LayoutNode>),
    /// `<Container>` — optional explicit dimensions; children rendered inside.
    Container {
        width: Option<f32>,
        height: Option<f32>,
        children: Vec<LayoutNode>,
    },
    /// `<Button>` — mapped by document order to the `btns` array entry at that index.
    Button { width: f32, height: f32 },
    /// `<Control>` — fixed spacer or fill (fill when both dims are `None`).
    Control {
        width: Option<f32>,
        height: Option<f32>,
    },
}

/// Parsed `MenuElementTemplate` from an `element_*.xml` skin file.
#[derive(Clone, Debug)]
pub struct ElementTemplate {
    pub height: f32,
    pub min_width: f32,
    pub max_width: f32,
    /// Root layout node built from `<MenuElementLayout>`'s children.
    pub layout: LayoutNode,
}

impl Default for ElementTemplate {
    fn default() -> Self {
        Self {
            height: 30.0,
            min_width: 0.0,
            max_width: f32::MAX,
            layout: LayoutNode::Horizontal(vec![]),
        }
    }
}

/// Parse an `element_*.xml` bytes slice into an [`ElementTemplate`].
///
/// Builds a [`LayoutNode`] tree that mirrors the DOM directly. The only
/// structural contract is that `<Button>` elements appear in the order they
/// map to the `btns` array — their container hierarchy is irrelevant and
/// survives any future XML schema changes unchanged.
pub fn parse_element_template(xml: &[u8]) -> ElementTemplate {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(true);

    let mut tpl = ElementTemplate::default();
    // Each frame: (tag_name_bytes, width_attr, height_attr, child_nodes)
    let mut stack: Vec<(Vec<u8>, Option<f32>, Option<f32>, Vec<LayoutNode>)> = vec![];

    loop {
        match reader.read_event() {
            Ok(Event::Start(ref e)) => {
                let name = e.name().as_ref().to_vec();
                let mut w: Option<f32> = None;
                let mut h: Option<f32> = None;
                for attr in e.attributes().flatten() {
                    if let Ok(v) = attr.unescape_value() {
                        match attr.key.as_ref() {
                            b"width" => {
                                w = v.parse().ok();
                            }
                            b"height" => {
                                h = v.parse().ok();
                            }
                            b"minwidth" if name == b"MenuElement" => {
                                if let Ok(f) = v.parse() {
                                    tpl.min_width = f;
                                }
                            }
                            b"maxwidth" if name == b"MenuElement" => {
                                if let Ok(f) = v.parse() {
                                    tpl.max_width = f;
                                }
                            }
                            _ => {}
                        }
                    }
                }
                if name == b"MenuElement" {
                    if let Some(hv) = h {
                        tpl.height = hv;
                    }
                }
                stack.push((name, w, h, vec![]));
            }
            Ok(Event::Empty(ref e)) => {
                let mut w: Option<f32> = None;
                let mut h: Option<f32> = None;
                for attr in e.attributes().flatten() {
                    if let Ok(v) = attr.unescape_value() {
                        match attr.key.as_ref() {
                            b"width" => {
                                w = v.parse().ok();
                            }
                            b"height" => {
                                h = v.parse().ok();
                            }
                            _ => {}
                        }
                    }
                }
                let node = match e.name().as_ref() {
                    b"Button" => Some(LayoutNode::Button {
                        width: w.unwrap_or(24.0),
                        height: h.unwrap_or(24.0),
                    }),
                    b"Control" => Some(LayoutNode::Control {
                        width: w,
                        height: h,
                    }),
                    b"Container" => Some(LayoutNode::Container {
                        width: w,
                        height: h,
                        children: vec![],
                    }),
                    _ => None,
                };
                if let (Some(node), Some((_, _, _, children))) = (node, stack.last_mut()) {
                    children.push(node);
                }
            }
            Ok(Event::End(_)) => {
                if let Some((name, w, h, children)) = stack.pop() {
                    let node: Option<LayoutNode> = match name.as_slice() {
                        b"HorizontalLayout" => Some(LayoutNode::Horizontal(children)),
                        b"VerticalLayout" => Some(LayoutNode::Vertical(children)),
                        b"Container" => Some(LayoutNode::Container {
                            width: w,
                            height: h,
                            children,
                        }),
                        b"MenuElementLayout" => {
                            // This is the layout root — children are the direct horizontal
                            // siblings inside the layout (Containers, VerticalLayout, etc.).
                            tpl.layout = LayoutNode::Horizontal(children);
                            None
                        }
                        _ => None, // structural wrappers (MenuElement, MenuElementTemplate…)
                    };
                    if let (Some(node), Some((_, _, _, parent))) = (node, stack.last_mut()) {
                        parent.push(node);
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }

    tpl
}

// ─── Button URL Parsing ───────────────────────────────────────────────────────

/// Image URI and tint color for a single button interaction state.
#[derive(Clone, Debug)]
pub struct BtnState {
    /// Image URI (e.g. `orpheus://…` or `file://…`).
    pub uri: String,
    /// Tint color from `svg_color='#AARRGGBB'`, if present.
    pub color: Option<egui::Color32>,
}

impl BtnState {
    fn from_dui_value(val: &str) -> Option<Self> {
        let uri = extract_single_quoted(val, "file")?.to_owned();
        let color = extract_single_quoted(val, "svg_color").and_then(parse_argb_color);
        Some(Self { uri, color })
    }
}

/// Per-state image data parsed from a `MenuItemBtn.url` DUI attribute string.
#[derive(Clone, Debug)]
pub struct BtnImages {
    pub normal: BtnState,
    pub hot: Option<BtnState>,
    pub pushed: Option<BtnState>,
    pub disabled: Option<BtnState>,
}

/// Parse a `MenuItemBtn.url` DUI attribute string into [`BtnImages`].
///
/// The string is a space-separated `key="value"` sequence, e.g.
/// `normalimage="file='…' svg_color='#b3483228'" hotimage="file='…' svg_color='#ff483228'"`.
/// Returns `None` if no valid `normalimage` key is found.
pub fn parse_btn_url(url: &str) -> Option<BtnImages> {
    let mut normal: Option<BtnState> = None;
    let mut hot: Option<BtnState> = None;
    let mut pushed: Option<BtnState> = None;
    let mut disabled: Option<BtnState> = None;

    let mut pos = 0;
    let bytes = url.as_bytes();

    while pos < url.len() {
        while pos < url.len() && matches!(bytes[pos], b' ' | b'\t' | b'\n' | b'\r') {
            pos += 1;
        }
        if pos >= url.len() {
            break;
        }

        let key_start = pos;
        while pos < url.len() && bytes[pos] != b'=' {
            pos += 1;
        }
        if pos >= url.len() {
            break;
        }
        let key = url[key_start..pos].trim();
        pos += 1;

        if pos >= url.len() || bytes[pos] != b'"' {
            break;
        }
        pos += 1;
        let val_start = pos;
        let mut in_single = false;
        while pos < url.len() {
            match bytes[pos] {
                b'\'' => {
                    in_single = !in_single;
                    pos += 1;
                }
                b'"' if !in_single => break,
                _ => {
                    pos += 1;
                }
            }
        }
        let val = &url[val_start..pos];
        pos += 1;

        match key {
            "normalimage" => {
                normal = BtnState::from_dui_value(val);
            }
            "hotimage" => {
                hot = BtnState::from_dui_value(val);
            }
            "pushedimage" => {
                pushed = BtnState::from_dui_value(val);
            }
            "disabledimage" => {
                disabled = BtnState::from_dui_value(val);
            }
            _ => {}
        }
    }

    Some(BtnImages {
        normal: normal?,
        hot,
        pushed,
        disabled,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SKIN_XML: &[u8] = br#"<?xml version="1.0" encoding="utf-8"?>
<Window>
  <Default name="Menu" value="maxwidth=&quot;195&quot; minwidth=&quot;186&quot; inset=&quot;12,16,12,16&quot; bkimage=&quot;file='menu/bk.png' corner='16,20,16,20' hole='false'&quot; itemhotimage=&quot;file='menu/hover.png' ytiled='true' xtiled='true'&quot; itemdisabledbkcolor=&quot;#FF99999D&quot;"/>
</Window>"#;

    #[test]
    fn parse_skin_xml() {
        let skin = parse_menu_skin(SKIN_XML);
        assert_eq!(skin.max_width, 195.0);
        assert_eq!(skin.min_width, 186.0);
        assert_eq!(skin.inset, [12.0, 16.0, 12.0, 16.0]); // top=12, left=16, bottom=12, right=16
        let bk = skin.bk_image.as_ref().unwrap();
        assert_eq!(bk.path, "menu/bk.png");
        assert_eq!(bk.corner, [16.0, 20.0, 16.0, 20.0]);
        assert_eq!(skin.item_hot_image.as_deref(), Some("menu/hover.png"));
        assert_eq!(
            skin.item_disabled_bk_color,
            Some(egui::Color32::from_rgba_unmultiplied(
                0x99, 0x99, 0x9D, 0xFF
            ))
        );
    }

    #[test]
    fn parse_argb() {
        let c = parse_argb_color("#FF99999D").unwrap();
        assert_eq!(
            c,
            egui::Color32::from_rgba_unmultiplied(0x99, 0x99, 0x9D, 0xFF)
        );
    }
}
