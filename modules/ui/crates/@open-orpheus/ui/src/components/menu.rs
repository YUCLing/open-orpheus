mod draw;
mod types;
#[cfg(target_os = "linux")]
mod wayland;

pub use types::{MenuData, MenuItem, MenuPosition};

use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use std::time::Duration;

use egui::{Color32, ViewportBuilder, ViewportId};
use winit::{
    dpi::LogicalPosition,
    event::WindowEvent,
};

use crate::{
    app::App,
    skin::{ElementTemplate, parse_element_template},
    util::random_string,
};

use draw::{clamp_to_screen, draw_menu_items, measure_items};

pub struct Menu {
    app: App,
    menu_data: Arc<MenuData>,
    click_handler: Option<Arc<dyn Fn(String) + Send + Sync + 'static>>,
}

impl Menu {
    pub fn new(app: &App, menu_data: MenuData) -> Self {
        Menu {
            app: app.clone(),
            menu_data: Arc::new(menu_data),
            click_handler: None,
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

    fn show_menu_with_items(
        app: App,
        items: Arc<Vec<MenuItem>>,
        position: MenuPosition,
        keep_open: Option<Arc<AtomicBool>>,
        opened_flag: Option<Arc<AtomicBool>>,
        is_root: bool,
        // Counts currently-open submenus at any depth; shared across the whole
        // menu tree so the root can distinguish "lost focus to submenu" from
        // "genuinely lost focus to something else".
        open_submenu_count: Arc<AtomicUsize>,
        click_handler: Option<Arc<dyn Fn(String) + Send + Sync + 'static>>,
        close_all: Arc<AtomicBool>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'static>> {
        Box::pin(async move {
            let skin = app.menu_skin.clone();
            let templates: Arc<std::collections::HashMap<String, ElementTemplate>> = {
                let mut map = std::collections::HashMap::new();
                for item in items.iter() {
                    if let Some(style) = &item.style {
                        if !map.contains_key(style.as_str()) {
                            let xml = app.resource_handler().read_skin_pack(&format!("/{}", style)).await;
                            map.insert(style.clone(), parse_element_template(&xml));
                        }
                    }
                }
                Arc::new(map)
            };

            let parent_item_hovered: Vec<Arc<AtomicBool>> = items
                .iter()
                .map(|_| Arc::new(AtomicBool::new(false)))
                .collect();
            let submenu_open: Vec<Arc<AtomicBool>> = items
                .iter()
                .map(|_| Arc::new(AtomicBool::new(false)))
                .collect();
            let app_for_closure = app.clone();

            // Non-root menus: we have already been counted by our parent at
            // spawn time; decrement when this task exits (see end of fn).

            let initial_size = measure_items(&items, &skin, templates.clone());

            // Slot for the pending click ID: written by the egui render closure,
            // read and drained by the polling loop.
            let pending_click: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
            // Shared slot written just after create_egui_window so the render
            // closure (which shares it) can learn its own window_id lazily.
            let self_window_id: Arc<OnceLock<winit::window::WindowId>> = Arc::new(OnceLock::new());

            // For AtCursor we skip with_position and let the compositor decide;
            // for RightOf we compute and clamp to the monitor.
            let logical_pos: Option<LogicalPosition<f64>> = match &position {
                MenuPosition::AtCursor => None,
                MenuPosition::RightOf { parent_window_id, row_y_offset } => {
                    let desired = if let Some((parent_pos, parent_size)) =
                        app.get_window_outer_rect(*parent_window_id).await
                    {
                        egui::Pos2::new(
                            (parent_pos.x + parent_size.width as i32) as f32,
                            parent_pos.y as f32 + row_y_offset,
                        )
                    } else {
                        egui::Pos2::ZERO
                    };
                    let monitors = app.get_monitor_rects(*parent_window_id).await;
                    let clamped = clamp_to_screen(desired, initial_size, &monitors);
                    Some(LogicalPosition::new(clamped.x as f64, clamped.y as f64))
                }
            };

            let mut builder = ViewportBuilder::default()
                .with_always_on_top()
                .with_window_level(egui::WindowLevel::AlwaysOnTop)
                .with_decorations(false)
                .with_taskbar(false)
                .with_resizable(false)
                .with_inner_size(initial_size);

            if let Some(pos) = logical_pos {
                builder = builder.with_position(egui::Pos2::new(pos.x as f32, pos.y as f32));
            }

            let (_ctx, window_id) = app
                .create_egui_window(ViewportId::from_hash_of(random_string(10)), builder, {
                    let self_window_id = self_window_id.clone();
                    let open_submenu_count = open_submenu_count.clone();
                    let templates = templates;
                    let click_handler_for_closure = click_handler.clone();
                    let close_all_for_closure = close_all.clone();
                    let pending_click_for_closure = pending_click.clone();
                    move |ctx| {
                        ctx.set_visuals(egui::Visuals::light());
                        let hover_fill = Color32::from_rgb(225, 235, 252);
                        let press_fill = Color32::from_rgb(198, 216, 249);
                        egui::CentralPanel::default()
                            .frame(egui::Frame::new().fill(Color32::WHITE))
                            .show(ctx, |ui| {
                                ui.style_mut().interaction.selectable_labels = false;
                                ui.vertical(|ui| {
                                    ui.style_mut().spacing.item_spacing.y = 0.0;
                                    let mut handle_click = |id: String| {
                                        *pending_click_for_closure.lock().unwrap() = Some(id);
                                    };
                                    draw_menu_items(ui, &items, &skin, &templates, |idx, response| {
                                        let item = &items[idx];
                                        let parent_hover = &parent_item_hovered[idx];
                                        let is_submenu_open = &submenu_open[idx];
                                        let is_hovered = response.hovered();
                                        parent_hover.store(is_hovered, Ordering::Relaxed);
                                        if is_hovered {
                                            if let Some(children) = &item.children {
                                                if !is_submenu_open.swap(true, Ordering::Relaxed) {
                                                    if let Some(&parent_wid) = self_window_id.get()
                                                    {
                                                        // Increment *before* spawn so the root's
                                                        // focus-loss guard already sees count > 0
                                                        // when the OS moves focus to the new window.
                                                        open_submenu_count
                                                            .fetch_add(1, Ordering::Relaxed);
                                                        smol::spawn(Self::show_menu_with_items(
                                                            app_for_closure.clone(),
                                                            children.clone(),
                                                            MenuPosition::RightOf {
                                                                parent_window_id: parent_wid,
                                                                row_y_offset: response.rect.top(),
                                                            },
                                                            Some(parent_hover.clone()),
                                                            Some(is_submenu_open.clone()),
                                                            false,
                                                            open_submenu_count.clone(),
                                                            click_handler_for_closure.clone(),
                                                            close_all_for_closure.clone(),
                                                        ))
                                                        .detach();
                                                    }
                                                }
                                            }
                                            return Some(hover_fill);
                                        }
                                        if response.is_pointer_button_down_on() {
                                            return Some(press_fill);
                                        }
                                        None
                                    }, &mut handle_click);
                                });
                            });
                    }
                })
                .await;

            // Write window_id into the shared slot so the render closure can use it.
            let _ = self_window_id.set(window_id);

            if let Some(parent_hovered) = keep_open {
                // Submenu: stay alive while parent entry or self is hovered.
                let self_hovered = Arc::new(AtomicBool::new(false));
                let close_requested = Arc::new(AtomicBool::new(false));
                app.set_window_message_handler(window_id, {
                    let self_hovered = self_hovered.clone();
                    let close_requested = close_requested.clone();
                    move |_window_id, event, _window| {
                        match event {
                            WindowEvent::CursorEntered { .. } => {
                                self_hovered.store(true, Ordering::Relaxed);
                            }
                            WindowEvent::CursorLeft { .. } => {
                                self_hovered.store(false, Ordering::Relaxed);
                            }
                            WindowEvent::CloseRequested => {
                                close_requested.store(true, Ordering::Relaxed);
                            }
                            _ => {}
                        }
                        false
                    }
                })
                .await;

                let mut missing_hover_ticks = 0;
                loop {
                    if close_requested.load(Ordering::Relaxed) {
                        break;
                    }
                    if close_all.load(Ordering::Relaxed) {
                        app.close_window(window_id).await;
                        break;
                    }
                    let pending_id = pending_click.lock().unwrap().take();
                    if let Some(id) = pending_id {
                        if let Some(handler) = &click_handler {
                            handler(id);
                        }
                        close_all.store(true, Ordering::Relaxed);
                        app.close_window(window_id).await;
                        break;
                    }
                    let hovered = parent_hovered.load(Ordering::Relaxed)
                        || self_hovered.load(Ordering::Relaxed);
                    if hovered {
                        missing_hover_ticks = 0;
                    } else {
                        missing_hover_ticks += 1;
                        if missing_hover_ticks >= 3 {
                            app.close_window(window_id).await;
                            break;
                        }
                    }
                    smol::Timer::after(Duration::from_millis(50)).await;
                }

                // Decrement the shared counter so the root menu knows this
                // submenu is gone and can act on future focus-loss events.
                open_submenu_count.fetch_sub(1, Ordering::Relaxed);
            } else if is_root {
                // Root menu: close when the window loses focus AND no submenu is open.
                let close_requested = Arc::new(AtomicBool::new(false));
                app.set_window_message_handler(window_id, {
                    let close_requested = close_requested.clone();
                    let open_submenu_count = open_submenu_count.clone();
                    move |_window_id, event, _window| {
                        match event {
                            WindowEvent::Focused(false) => {
                                // Ignore focus loss when we just opened a submenu;
                                // the count was incremented before spawn so it is
                                // already > 0 here.
                                if open_submenu_count.load(Ordering::Relaxed) == 0 {
                                    close_requested.store(true, Ordering::Relaxed);
                                }
                            }
                            WindowEvent::CloseRequested => {
                                close_requested.store(true, Ordering::Relaxed);
                            }
                            _ => {}
                        }
                        false
                    }
                })
                .await;

                loop {
                    if close_requested.load(Ordering::Relaxed) || close_all.load(Ordering::Relaxed) {
                        app.close_window(window_id).await;
                        break;
                    }
                    let pending_id = pending_click.lock().unwrap().take();
                    if let Some(id) = pending_id {
                        if let Some(handler) = &click_handler {
                            handler(id);
                        }
                        close_all.store(true, Ordering::Relaxed);
                        app.close_window(window_id).await;
                        break;
                    }
                    smol::Timer::after(Duration::from_millis(50)).await;
                }
            }

            if let Some(opened_flag) = opened_flag {
                opened_flag.store(false, Ordering::Relaxed);
            }
        })
    }

    pub fn show(&self) {
        let menu_data = self.menu_data.clone();
        let app = self.app.clone();
        #[cfg(target_os = "linux")]
        if app.is_wayland() {
            smol::spawn(wayland::show_wayland_overlay(app, menu_data.content.clone(), self.click_handler.clone())).detach();
            return;
        }
        let close_all = Arc::new(AtomicBool::new(false));
        smol::spawn(Self::show_menu_with_items(
            app,
            menu_data.content.clone(),
            MenuPosition::AtCursor,
            None,
            None,
            true,
            Arc::new(AtomicUsize::new(0)),
            self.click_handler.clone(),
            close_all,
        ))
        .detach();
    }
}
