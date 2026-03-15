use std::{collections::HashMap, sync::Arc};

use serde::Deserialize;

#[derive(Deserialize)]
pub struct MenuItemBtn {
    id: String,
    url: String,
    enable: bool,
}

#[derive(Deserialize)]
pub struct MenuItem {
    text: String,
    menu: bool,
    enable: bool,
    separator: bool,
    children: Option<Arc<Vec<MenuItem>>>,
    image_color: String,
    image_path: Option<String>,
    menu_id: Option<String>,
    btns: Option<Vec<MenuItemBtn>>,
}

#[derive(Deserialize)]
pub struct MenuData {
    content: Arc<Vec<MenuItem>>,
    hotkey: HashMap<String, String>,
    left_border_size: f64,
    menu_type: String,
}
