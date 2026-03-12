use std::{collections::HashMap, sync::Arc};

use egui::{ViewportBuilder, ViewportId};
use serde::Deserialize;

use crate::app::App;

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
    children: Option<Vec<MenuItem>>,
    image_color: String,
    image_path: Option<String>,
    menu_id: Option<String>,
    btns: Option<Vec<MenuItemBtn>>,
}

#[derive(Deserialize)]
pub struct MenuData {
    content: Vec<MenuItem>,
    hotkey: HashMap<String, String>,
    left_border_size: f64,
    menu_type: String,
}

pub struct Menu {
    app: App,
    menu_data: Arc<MenuData>,
}

impl Menu {
    pub fn new(app: &App, menu_data: MenuData) -> Self {
        Menu {
            app: app.clone(),
            menu_data: Arc::new(menu_data),
        }
    }

    pub fn show(&self) {
        let menu_data = self.menu_data.clone();
        smol::block_on(
            self.app.create_egui_window(
                ViewportId::from_hash_of("menu"),
                ViewportBuilder::default()
                    .with_always_on_top()
                    .with_window_level(egui::WindowLevel::AlwaysOnTop),
                move |ctx| {
                    egui::CentralPanel::default().show(ctx, |ui| {
                        ui.vertical(|ui| {
                            for item in &menu_data.content {
                                if item.separator {
                                    ui.separator();
                                    continue;
                                }
                                ui.horizontal(|ui| {
                                    if let Some(image) = &item.image_path {
                                        let image = egui::Image::new(image);
                                        ui.add(image);
                                    }
                                    ui.label(&item.text);
                                });
                            }
                        });
                    });
                },
            ),
        );
    }
}
