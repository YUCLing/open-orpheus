use egui::{ViewportBuilder, ViewportId};
use neon::types::extract::Json;

#[cfg(not(target_os = "macos"))]
use crate::app::{
    App,
    menu::{Menu, MenuData},
};

#[cfg(not(target_os = "macos"))]
mod app;
mod util;

// Use #[neon::export] to export Rust functions as JavaScript functions.
// See more at: https://docs.rs/neon/latest/neon/attr.export.html

#[cfg(not(target_os = "macos"))]
#[neon::export]
fn create_app() -> f64 {
    smol::block_on(async {
        let app = App::new().await;
        let ptr = Box::into_raw(Box::new(app));
        ptr as usize as f64
    })
}

/// For testing purposes.
#[cfg(not(target_os = "macos"))]
#[neon::export]
fn create_window(app_ptr: f64) {
    let app = unsafe { &mut *(app_ptr as usize as *mut App) };
    let viewport_id = ViewportId::from_hash_of("test");
    let viewport_builder = ViewportBuilder::default()
        .with_always_on_top()
        .with_visible(true)
        .with_title("EGUI Test");
    smol::block_on(async {
        let (_ctx, id) = app
            .create_egui_window(viewport_id, viewport_builder, |ctx| {
                egui::CentralPanel::default().show(ctx, |ui| {
                    ui.label("Hello, World!");
                });
            })
            .await;
        app.show_window(id).await;
    });
}

/// Not final API.
#[cfg(not(target_os = "macos"))]
#[neon::export]
fn create_menu(app_ptr: f64, menu_data: Json<MenuData>) {
    let app = unsafe { &mut *(app_ptr as usize as *mut App) };

    let menu = Menu::new(app, menu_data.0);
    menu.show();
}

// Use #[neon::main] to add additional behavior at module loading time.
// See more at: https://docs.rs/neon/latest/neon/attr.main.html

// #[neon::main]
// fn main(_cx: ModuleContext) -> NeonResult<()> {
//     println!("module is loaded!");
//     Ok(())
// }
