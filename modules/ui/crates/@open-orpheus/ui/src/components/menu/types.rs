use std::{collections::HashMap, sync::Arc};

use serde::Deserialize;

#[derive(Deserialize, Clone)]
pub struct MenuItemBtn {
    pub id: String,
    pub url: String,
    pub enable: bool,
}

#[derive(Deserialize, Clone)]
pub struct MenuItem {
    pub text: String,
    pub menu: bool,
    pub enable: bool,
    pub separator: bool,
    pub children: Option<Arc<Vec<MenuItem>>>,
    pub image_color: String,
    pub image_path: Option<String>,
    pub check_image_path: Option<String>,
    pub menu_id: Option<String>,
    pub style: Option<String>,
    pub btns: Option<Vec<MenuItemBtn>>,
}

// TODO: Operate on original `MenuItem`
/// A partial update for a [`MenuItem`].
///
/// - Absent key in JSON / field left as `None` → inherit from the base item unchanged.
/// - Non-optional fields (`text`, `menu`, `enable`, `separator`, `image_color`):
///   `Some(v)` → overwrite with `v`.
/// - Originally-optional fields (`children`, `image_path`, `check_image_path`,
///   `style`, `btns`, `menu_id`): double-`Option` so the three states are distinct:
///   - `None` (key absent)        → inherit from base
///   - `Some(None)` (`null`)      → explicitly clear (set to `None`)
///   - `Some(Some(v))` (`"..."`)  → set to `Some(v)`
///
/// Serde: `#[serde(default)]` makes absent keys deserialize to `None`; the inner
/// `Option` lets `null` map to `Some(None)`.
#[derive(Deserialize, Clone, Default)]
#[serde(default)]
pub struct MenuItemPatch {
    pub menu_id: Option<Option<String>>,
    pub text: Option<String>,
    pub menu: Option<bool>,
    pub enable: Option<bool>,
    pub separator: Option<bool>,
    pub children: Option<Option<Arc<Vec<MenuItem>>>>,
    pub image_color: Option<String>,
    pub image_path: Option<Option<String>>,
    pub check_image_path: Option<Option<String>>,
    pub style: Option<Option<String>>,
    pub btns: Option<Option<Vec<MenuItemBtn>>>,
}

impl MenuItemPatch {
    /// Applies this patch on top of `base`, returning a fully-populated [`MenuItem`].
    pub fn apply_to(&self, base: &MenuItem) -> MenuItem {
        MenuItem {
            text: self.text.clone().unwrap_or_else(|| base.text.clone()),
            menu: self.menu.unwrap_or(base.menu),
            enable: self.enable.unwrap_or(base.enable),
            separator: self.separator.unwrap_or(base.separator),
            image_color: self
                .image_color
                .clone()
                .unwrap_or_else(|| base.image_color.clone()),
            // Double-Option fields: None → inherit, Some(v) → overwrite (v may be None).
            menu_id: match &self.menu_id {
                None => base.menu_id.clone(),
                Some(v) => v.clone(),
            },
            children: match &self.children {
                None => base.children.clone(),
                Some(v) => v.clone(),
            },
            image_path: match &self.image_path {
                None => base.image_path.clone(),
                Some(v) => v.clone(),
            },
            check_image_path: match &self.check_image_path {
                None => base.check_image_path.clone(),
                Some(v) => v.clone(),
            },
            style: match &self.style {
                None => base.style.clone(),
                Some(v) => v.clone(),
            },
            btns: match &self.btns {
                None => base.btns.clone(),
                Some(v) => v.clone(),
            },
        }
    }
}

#[derive(Deserialize)]
pub struct MenuData {
    pub content: Arc<Vec<MenuItem>>,
    pub hotkey: HashMap<String, String>,
    pub left_border_size: f64,
    pub menu_type: String,
}

/// Desired origin for a menu window (logical pixels).
pub enum MenuPosition {
    /// Place to the right of a parent menu window, aligned with a specific
    /// vertical offset inside that parent (the top of the hovered row).
    RightOf {
        parent_window_id: winit::window::WindowId,
        row_y_offset: f32,
    },
    /// No preference — use the current cursor position on platforms that
    /// expose it, otherwise fall back to (0, 0).
    AtCursor,
}
