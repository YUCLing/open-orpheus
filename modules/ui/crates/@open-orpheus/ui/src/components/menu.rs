mod draw;
mod popup;
mod shared;
mod types;
#[cfg(target_os = "linux")]
mod wayland;

pub use types::{MenuData, MenuItemPatch};

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use crate::app::App;

pub struct Menu {
    app: App,
    menu_data: Arc<MenuData>,
    click_handler: Option<Arc<dyn Fn(String) + Send + Sync + 'static>>,
    item_overrides: Arc<RwLock<HashMap<String, MenuItemPatch>>>,
}

impl Menu {
    pub fn new(app: &App, menu_data: MenuData) -> Self {
        Menu {
            app: app.clone(),
            menu_data: Arc::new(menu_data),
            click_handler: None,
            item_overrides: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Set a handler that is called when a menu item (or icon button) is
    /// clicked. Receives the item's `menu_id` for text rows, or the button's
    /// `id` for icon-button rows. Builder-style, takes `self`.
    pub fn on_click(mut self, handler: impl Fn(String) + Send + Sync + 'static) -> Self {
        self.click_handler = Some(Arc::new(handler));
        self
    }

    /// Same as [`on_click`] but operates on a mutable reference, for use when
    /// the `Menu` is already boxed/heap-allocated.
    pub fn set_click_handler(&mut self, handler: impl Fn(String) + Send + Sync + 'static) {
        self.click_handler = Some(Arc::new(handler));
    }

    /// Update an existing item in a live menu using a partial patch.
    /// Only fields set to `Some(v)` in `patch` are changed; the rest are
    /// inherited from the original item on the next rendered frame.
    /// The target item is identified by `patch.menu_id`; has no effect if
    /// `menu_id` is absent from the patch or the menu is not currently open.
    pub fn update_item(&self, patch: MenuItemPatch) {
        if let Some(Some(menu_id)) = patch.menu_id.clone() {
            self.item_overrides.write().unwrap().insert(menu_id, patch);
        }
        smol::block_on(self.app.repaint_all());
    }

    pub fn show(&self) {
        let menu_data = self.menu_data.clone();
        let app = self.app.clone();
        let click_handler = self.click_handler.clone();
        let item_overrides = self.item_overrides.clone();

        #[cfg(target_os = "linux")]
        if app.is_wayland() {
            smol::spawn(wayland::show_wayland_overlay(
                app,
                menu_data.content.clone(),
                click_handler,
                item_overrides,
            ))
            .detach();
            return;
        }

        smol::spawn(popup::show_popup_menu(
            app,
            menu_data.content.clone(),
            click_handler,
            item_overrides,
        ))
        .detach();
    }
}
