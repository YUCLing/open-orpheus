use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, RwLock,
    },
    time::{Duration, Instant},
};

use egui::{Color32, Margin, ViewportId};
use winit::window::WindowId;

use crate::{app::App, util::random_string};

use super::{
    draw::{clamp_to_screen, draw_menu_items, load_templates, measure_items},
    shared::{HOVER_FILL, POLL_INTERVAL_MS, PRESS_FILL, menu_viewport_builder},
    types::{MenuItem, MenuItemPatch},
};

struct LevelInfo {
    window_id: WindowId,
    screen_pos: egui::Pos2,
    /// Pre-set to `true` on creation. Updated by the window message handler.
    focused: Arc<AtomicBool>,
    /// Index of the item in the parent level that opened this submenu.
    /// `None` for the root level.
    opened_from_item: Option<usize>,
}

struct OpenRequest {
    parent_depth: usize,
    parent_item_idx: usize,
    screen_pos: egui::Pos2,
    children: Arc<Vec<MenuItem>>,
}

struct MenuStack {
    levels: Vec<LevelInfo>,
    pending_open: Option<OpenRequest>,
    pending_close_to: Option<usize>,
    pending_click: Option<(String, bool)>,
    dismiss: bool,
    focus_lost_at: Option<Instant>,
}

enum LoopAction {
    Idle,
    Dismiss,
    Click { id: String, close_all: bool },
    OpenSubmenu {
        close_from: usize,
        parent_item_idx: usize,
        to_close: Vec<WindowId>,
        children: Arc<Vec<MenuItem>>,
        desired_pos: egui::Pos2,
    },
    TrimTo { to_close: Vec<WindowId> },
}

/// Per-level popup windows implementation for X11 / macOS / Windows.
pub async fn show_popup_menu(
    app: App,
    items: Arc<Vec<MenuItem>>,
    click_handler: Option<Arc<dyn Fn(String) + Send + Sync + 'static>>,
    item_overrides: Arc<RwLock<HashMap<String, MenuItemPatch>>>,
) {
    let skin = app
        .menu_skin
        .clone()
        .expect("load_skin must be called before creating menus");

    let templates = load_templates(&app, &items).await;
    let root_size = measure_items(&items, &skin, templates.clone());
    let cursor_pos = query_cursor_position(&app).await;

    let stack: Arc<Mutex<MenuStack>> = Arc::new(Mutex::new(MenuStack {
        levels: Vec::new(),
        pending_open: None,
        pending_close_to: None,
        pending_click: None,
        dismiss: false,
        focus_lost_at: None,
    }));

    let root_window_id = create_level_window(
        &app, &stack, &skin, &templates, &item_overrides,
        0, None, items.clone(), cursor_pos, root_size,
    )
    .await;

    // Clamp root position using monitor info.
    let monitors = app.get_monitor_rects(root_window_id).await;
    let clamped_root = clamp_to_screen(cursor_pos, root_size, &monitors);
    if clamped_root != cursor_pos {
        stack.lock().unwrap().levels[0].screen_pos = clamped_root;
    }

    // Coordinator poll loop.
    loop {
        smol::Timer::after(Duration::from_millis(POLL_INTERVAL_MS)).await;

        let action = {
            let mut g = stack.lock().unwrap();

            // Update focus_lost_at based on per-window focused flags.
            let any_focused = g.levels.iter().any(|l| l.focused.load(Ordering::SeqCst));
            if any_focused {
                g.focus_lost_at = None;
            } else if g.focus_lost_at.is_none() && !g.levels.is_empty() {
                g.focus_lost_at = Some(Instant::now());
            }

            if g.dismiss {
                eprintln!("[MENU-DBG] Coordinator: dismiss=true => Dismiss");
                LoopAction::Dismiss
            } else if g.focus_lost_at.is_some_and(|t| t.elapsed().as_millis() >= 150)
            {
                eprintln!("[MENU-DBG] Coordinator: focus_lost dismiss! any_focused={any_focused} lost_elapsed={:?}ms levels={}",
                    g.focus_lost_at.map(|t| t.elapsed().as_millis()),
                    g.levels.len());
                g.dismiss = true;
                LoopAction::Dismiss
            } else if let Some((id, close_all)) = g.pending_click.take() {
                LoopAction::Click { id, close_all }
            } else if let Some(req) = g.pending_open.take() {
                let close_from = req.parent_depth + 1;
                // If a submenu at this depth already shows the same parent item, skip.
                if close_from < g.levels.len()
                    && g.levels[close_from].opened_from_item == Some(req.parent_item_idx)
                {
                    g.pending_close_to = None; // don't let stale close nuke this submenu
                    LoopAction::Idle
                } else {
                    let to_close: Vec<WindowId> =
                        g.levels.drain(close_from..).map(|l| l.window_id).collect();
                    LoopAction::OpenSubmenu {
                        close_from, parent_item_idx: req.parent_item_idx,
                        to_close, children: req.children, desired_pos: req.screen_pos,
                    }
                }
            } else if let Some(close_to) = g.pending_close_to.take() {
                if close_to < g.levels.len() {
                    eprintln!("[MENU-DBG] Coordinator: TrimTo close_to={close_to} levels={}", g.levels.len());
                    let to_close: Vec<WindowId> =
                        g.levels.drain(close_to..).map(|l| l.window_id).collect();
                    LoopAction::TrimTo { to_close }
                } else {
                    LoopAction::Idle
                }
            } else {
                LoopAction::Idle
            }
        }; // guard dropped

        match action {
            LoopAction::Idle => {}

            LoopAction::Dismiss => {
                let wids: Vec<WindowId> =
                    stack.lock().unwrap().levels.iter().map(|l| l.window_id).collect();
                for wid in wids {
                    app.close_window(wid).await;
                }
                break;
            }

            LoopAction::Click { id, close_all } => {
                if let Some(handler) = &click_handler {
                    handler(id);
                }
                if close_all {
                    let wids: Vec<WindowId> =
                        stack.lock().unwrap().levels.iter().map(|l| l.window_id).collect();
                    for wid in wids {
                        app.close_window(wid).await;
                    }
                    break;
                }
            }

            LoopAction::OpenSubmenu { close_from, parent_item_idx, to_close, children, desired_pos } => {
                for wid in to_close {
                    app.close_window(wid).await;
                }
                let sub_size = measure_items(&children, &skin, templates.clone());
                let monitors = app.get_monitor_rects(root_window_id).await;

                let mut sub_pos = desired_pos;
                let parent_x = {
                    let g = stack.lock().unwrap();
                    if close_from > 0 && close_from - 1 < g.levels.len() {
                        g.levels[close_from - 1].screen_pos.x
                    } else {
                        sub_pos.x
                    }
                };

                let clamped = clamp_to_screen(sub_pos, sub_size, &monitors);
                if clamped.x < sub_pos.x && sub_pos.x > parent_x {
                    sub_pos.x = parent_x - sub_size.x;
                    sub_pos = clamp_to_screen(sub_pos, sub_size, &monitors);
                } else {
                    sub_pos = clamped;
                }

                eprintln!("[MENU-DBG] Coordinator: OpenSubmenu close_from={close_from}");

                create_level_window(
                    &app, &stack, &skin, &templates, &item_overrides,
                    close_from, Some(parent_item_idx), children, sub_pos, sub_size,
                )
                .await;
            }

            LoopAction::TrimTo { to_close } => {
                for wid in to_close {
                    app.close_window(wid).await;
                }
            }
        }
    }
}

async fn query_cursor_position(app: &App) -> egui::Pos2 {
    let cursor: Arc<Mutex<Option<egui::Pos2>>> = Arc::new(Mutex::new(None));

    let builder = menu_viewport_builder()
        .with_inner_size(egui::Vec2::new(1.0, 1.0))
        .with_position(egui::Pos2::ZERO);

    let (_ctx, probe_wid) = app
        .create_egui_window(
            ViewportId::from_hash_of(random_string(10)),
            builder,
            |_ctx| {},
        )
        .await;

    app.set_window_message_handler(probe_wid, {
        let cursor = cursor.clone();
        move |_wid, event, win| {
            if let winit::event::WindowEvent::CursorMoved { position, .. } = event {
                let mut c = cursor.lock().unwrap();
                if c.is_none() {
                    let scale = win.scale_factor() as f32;
                    *c = Some(egui::Pos2::new(
                        position.x as f32 / scale,
                        position.y as f32 / scale,
                    ));
                }
            }
            false
        }
    })
    .await;

    let deadline = Instant::now() + Duration::from_millis(50);
    loop {
        if cursor.lock().unwrap().is_some() {
            break;
        }
        if Instant::now() >= deadline {
            break;
        }
        smol::Timer::after(Duration::from_millis(4)).await;
    }

    let pos = cursor.lock().unwrap().unwrap_or(egui::Pos2::ZERO);
    app.close_window(probe_wid).await;
    pos
}

async fn create_level_window(
    app: &App,
    stack: &Arc<Mutex<MenuStack>>,
    skin: &Arc<crate::skin::MenuSkin>,
    templates: &Arc<std::collections::HashMap<String, crate::skin::ElementTemplate>>,
    item_overrides: &Arc<RwLock<HashMap<String, MenuItemPatch>>>,
    depth: usize,
    opened_from_item: Option<usize>,
    items: Arc<Vec<MenuItem>>,
    screen_pos: egui::Pos2,
    size: egui::Vec2,
) -> WindowId {
    let builder = menu_viewport_builder()
        .with_inner_size(size)
        .with_position(screen_pos);

    let (_ctx, window_id) = app
        .create_egui_window(
            ViewportId::from_hash_of(random_string(10)),
            builder,
            {
                let stack = stack.clone();
                let items = items.clone();
                let skin = skin.clone();
                let templates = templates.clone();
                let item_overrides = item_overrides.clone();
                move |ctx| {
                    ctx.set_visuals(egui::Visuals {
                        panel_fill: Color32::WHITE,
                        window_shadow: egui::Shadow::NONE,
                        ..egui::Visuals::light()
                    });

                    egui::CentralPanel::default()
                        .frame(
                            egui::Frame::popup(&ctx.style())
                                .inner_margin(Margin::ZERO)
                                .fill(Color32::WHITE),
                        )
                        .show(ctx, |ui| {
                            ui.style_mut().interaction.selectable_labels = false;
                            ui.style_mut().spacing.item_spacing.y = 0.0;

                            let mut guard = stack.lock().unwrap();
                            let overrides_guard = item_overrides.read().unwrap();

                            let mut pending_click_local: Option<(String, bool)> = None;

                            draw_menu_items(
                                ui,
                                &items,
                                &skin,
                                &templates,
                                &overrides_guard,
                                |_idx, effective_item, response| {
                                    if response.hovered() {
                                        if let Some(children) = &effective_item.children {
                                            let sub_screen = egui::Pos2::new(
                                                screen_pos.x + response.rect.right(),
                                                screen_pos.y + response.rect.top(),
                                            );
                                            guard.pending_close_to = None; // mutually exclusive
                                            guard.pending_open = Some(OpenRequest {
                                                parent_depth: depth,
                                                parent_item_idx: _idx,
                                                screen_pos: sub_screen,
                                                children: children.clone(),
                                            });
                                        } else {
                                            guard.pending_open = None; // mutually exclusive
                                            guard.pending_close_to = Some(depth + 1);
                                        }
                                        return Some(HOVER_FILL);
                                    }
                                    if response.is_pointer_button_down_on() {
                                        return Some(PRESS_FILL);
                                    }
                                    None
                                },
                                &mut |id: String, close: bool| {
                                    pending_click_local = Some((id, close));
                                },
                            );

                            if let Some(click) = pending_click_local {
                                guard.pending_click = Some(click);
                            }

                            if ctx.input(|i| i.key_pressed(egui::Key::Escape)) {
                                eprintln!("[MENU-DBG] Escape pressed depth={depth}");
                                guard.dismiss = true;
                            }
                        });
                }
            },
        )
        .await;

    let focused_flag = Arc::new(AtomicBool::new(true));

    app.set_window_message_handler(window_id, {
        let stack = stack.clone();
        let focused_flag = focused_flag.clone();
        move |_wid, event, _win| {
            match event {
                winit::event::WindowEvent::Focused(focused) => {
                    focused_flag.store(*focused, Ordering::SeqCst);
                    eprintln!("[MENU-DBG] Focused({focused}) depth={depth}");
                }
                winit::event::WindowEvent::CloseRequested => {
                    eprintln!("[MENU-DBG] CloseRequested depth={depth}");
                    stack.lock().unwrap().dismiss = true;
                }
                _ => {}
            }
            false
        }
    })
    .await;

    stack.lock().unwrap().levels.push(LevelInfo {
        window_id,
        screen_pos,
        focused: focused_flag,
        opened_from_item,
    });

    window_id
}
