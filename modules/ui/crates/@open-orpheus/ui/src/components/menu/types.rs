use std::{collections::HashMap, sync::Arc};

use serde::Deserialize;

#[derive(Deserialize)]
pub struct MenuItemBtn {
    pub id: String,
    pub url: String,
    pub enable: bool,
}

#[derive(Deserialize)]
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
