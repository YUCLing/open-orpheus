use std::{
    collections::HashMap,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

use egui::{Color32, Margin, Pos2, Vec2, ViewportBuilder, ViewportId};
use serde::Deserialize;
use winit::{
    dpi::{LogicalPosition, PhysicalPosition, PhysicalSize},
    event::WindowEvent,
};

use crate::{app::App, util::random_string};

/// Desired origin for a menu window (logical pixels).
pub enum MenuPosition {
    /// Explicit position — used for root menus when the caller knows where it
    /// should appear (e.g. system tray icon coordinates).
    At(f64, f64),
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

/// Compute the final logical position for a popup window of `size`, trying to
/// stay inside the monitor that contains `desired_pos`.
///
/// `monitors` is a list of `(physical_pos, physical_size)` tuples. If empty the
/// function just returns `desired_pos` unchanged.
fn clamp_to_screen(
    desired: Pos2,
    size: Vec2,
    monitors: &[(PhysicalPosition<i32>, PhysicalSize<u32>)],
) -> Pos2 {
    // Find the monitor whose rect contains `desired`, or fall back to the first.
    let monitor = monitors
        .iter()
        .find(|(pos, sz)| {
            desired.x >= pos.x as f32
                && desired.y >= pos.y as f32
                && desired.x < (pos.x as f32 + sz.width as f32)
                && desired.y < (pos.y as f32 + sz.height as f32)
        })
        .or_else(|| monitors.first());

    let Some((mon_pos, mon_size)) = monitor else {
        return desired;
    };

    let mon_x = mon_pos.x as f32;
    let mon_y = mon_pos.y as f32;
    let mon_w = mon_size.width as f32;
    let mon_h = mon_size.height as f32;

    let x = desired.x.min(mon_x + mon_w - size.x).max(mon_x);
    let y = desired.y.min(mon_y + mon_h - size.y).max(mon_y);
    Pos2::new(x, y)
}

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

pub struct Menu {
    app: App,
    menu_data: Arc<MenuData>,
}

const MENU_WIDTH: f32 = 200.0;

/// Renders all menu items into `ui`.
///
/// For each non-separator item, `on_item(index, &response)` is called after
/// layout. The callback may return a `Color32` to override the frame fill
/// (for hover/press highlights), or `None` to leave it transparent.
/// For a pure measurement pass, pass `|_, _| None`.
fn draw_menu_items(
    ui: &mut egui::Ui,
    items: &[MenuItem],
    mut on_item: impl FnMut(usize, &egui::Response) -> Option<Color32>,
) {
    ui.add_space(4.0);
    for (idx, item) in items.iter().enumerate() {
        if item.separator {
            ui.add_space(4.0);
            ui.separator();
            ui.add_space(4.0);
            continue;
        }
        let width = ui.available_width();
        let mut frame = egui::Frame::new()
            .inner_margin(Margin::symmetric(8, 4))
            .begin(ui);
        frame.content_ui.set_width(width);
        frame.content_ui.horizontal(|ui| {
            if let Some(image) = &item.image_path {
                ui.add(egui::Image::new(image));
            }
            ui.label(&item.text);
        });
        let response = frame.allocate_space(ui);
        if let Some(fill) = on_item(idx, &response) {
            frame.frame.fill = fill;
        }
        frame.end(ui);
    }
    ui.add_space(4.0);
}

/// Runs a synchronous headless egui layout pass to measure the natural size of
/// the menu content. This avoids relying on post-creation window resizing, which
/// is unreliable on Wayland.
fn measure_items(items: &[MenuItem]) -> Vec2 {
    let ctx = egui::Context::default();
    ctx.set_fonts(super::fonts::get_font_definitions());
    let mut measured = Vec2::ZERO;
    let _ = ctx.run(
        egui::RawInput {
            screen_rect: Some(egui::Rect::from_min_size(
                egui::Pos2::ZERO,
                Vec2::new(MENU_WIDTH, 10_000.0),
            )),
            ..Default::default()
        },
        |ctx| {
            egui::CentralPanel::default()
                .frame(egui::Frame::new())
                .show(ctx, |ui| {
                    let v = ui.vertical(|ui| {
                        ui.style_mut().spacing.item_spacing.y = 0.0;
                        draw_menu_items(ui, items, |_, _| None);
                    });
                    measured = v.response.rect.size();
                });
        },
    );
    measured
}

impl Menu {
    pub fn new(app: &App, menu_data: MenuData) -> Self {
        Menu {
            app: app.clone(),
            menu_data: Arc::new(menu_data),
        }
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
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'static>> {
        Box::pin(async move {
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

            let initial_size = measure_items(&items);

            // Shared slot written just after create_egui_window so the render
            // closure (which shares it) can learn its own window_id lazily.
            let self_window_id: Arc<OnceLock<winit::window::WindowId>> = Arc::new(OnceLock::new());

            // Resolve the logical position the window should appear at.
            let logical_pos: LogicalPosition<f64> = {
                let desired: Pos2 = match &position {
                    MenuPosition::At(x, y) => Pos2::new(*x as f32, *y as f32),
                    MenuPosition::AtCursor => Pos2::ZERO, // compositor will place it
                    MenuPosition::RightOf {
                        parent_window_id,
                        row_y_offset,
                    } => {
                        if let Some((parent_pos, parent_size)) =
                            app.get_window_outer_rect(*parent_window_id).await
                        {
                            // Try to the right first; will be clamped below.
                            Pos2::new(
                                (parent_pos.x + parent_size.width as i32) as f32,
                                parent_pos.y as f32 + row_y_offset,
                            )
                        } else {
                            Pos2::ZERO
                        }
                    }
                };

                // Collect monitor geometry so we can clamp.
                // We gather it from the parent window's monitor where possible.
                let monitors: Vec<(PhysicalPosition<i32>, PhysicalSize<u32>)> = match &position {
                    MenuPosition::RightOf {
                        parent_window_id, ..
                    } => app.get_monitor_rects(*parent_window_id).await,
                    _ => vec![],
                };

                let clamped = clamp_to_screen(desired, initial_size, &monitors);
                LogicalPosition::new(clamped.x as f64, clamped.y as f64)
            };

            // For AtCursor we skip with_position and let the compositor decide;
            // for everything else we set it explicitly.
            let maybe_with_position = !matches!(position, MenuPosition::AtCursor);

            let mut builder = ViewportBuilder::default()
                .with_always_on_top()
                .with_window_level(egui::WindowLevel::AlwaysOnTop)
                .with_decorations(false)
                .with_taskbar(false)
                .with_resizable(false)
                .with_inner_size(initial_size);

            if maybe_with_position {
                builder =
                    builder.with_position(Pos2::new(logical_pos.x as f32, logical_pos.y as f32));
            }

            let (_ctx, window_id) = app
                .create_egui_window(ViewportId::from_hash_of(random_string(10)), builder, {
                    let self_window_id = self_window_id.clone();
                    let open_submenu_count = open_submenu_count.clone();
                    move |ctx| {
                        egui::CentralPanel::default()
                            .frame(egui::Frame::new())
                            .show(ctx, |ui| {
                                ui.style_mut().interaction.selectable_labels = false;
                                ui.vertical(|ui| {
                                    ui.style_mut().spacing.item_spacing.y = 0.0;
                                    draw_menu_items(ui, &items, |idx, response| {
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
                                                        ))
                                                        .detach();
                                                    }
                                                }
                                            }
                                            return Some(Color32::from_rgba_unmultiplied(
                                                0, 0, 0, 50,
                                            ));
                                        }
                                        if response.is_pointer_button_down_on() {
                                            return Some(Color32::from_rgba_unmultiplied(
                                                0, 0, 0, 75,
                                            ));
                                        }
                                        None
                                    });
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
                    if close_requested.load(Ordering::Relaxed) {
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
        smol::spawn(Self::show_menu_with_items(
            app,
            menu_data.content.clone(),
            MenuPosition::AtCursor,
            None,
            None,
            true,
            Arc::new(AtomicUsize::new(0)),
        ))
        .detach();
    }

    pub fn show_at(&self, x: f64, y: f64) {
        let menu_data = self.menu_data.clone();
        let app = self.app.clone();
        smol::spawn(Self::show_menu_with_items(
            app,
            menu_data.content.clone(),
            MenuPosition::At(x, y),
            None,
            None,
            true,
            Arc::new(AtomicUsize::new(0)),
        ))
        .detach();
    }
}
