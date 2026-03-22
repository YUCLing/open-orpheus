use std::{
    collections::HashMap,
    sync::atomic::{AtomicBool, Ordering},
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};

use egui::{Color32, Margin, ViewportId};

use crate::{app::App, util::random_string};

use super::{
    draw::{draw_menu_items, load_templates, measure_items},
    shared::{HOVER_FILL, POLL_INTERVAL_MS, PRESS_FILL, SUBMENU_IDLE_MS, menu_viewport_builder},
    types::{MenuItem, MenuItemPatch},
};

type MenuLevelStack = Arc<Mutex<Vec<(Arc<Vec<MenuItem>>, egui::Pos2, f32)>>>;

/// Wayland-only: renders the entire menu tree (root + submenus) as `egui::Area`s
/// inside a single transparent fullscreen overlay window so we don't fight
/// the compositor over window positions.
pub async fn show_wayland_overlay(
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

    // Large enough to cover any monitor; transparency hides the rest.
    const OVERLAY_W: f32 = 8192.0;
    const OVERLAY_H: f32 = 8192.0;

    // Stack of open levels: (items, top-left position in egui space, measured width).
    // Level 0 is the root menu; each subsequent entry is a submenu.
    let root_size = measure_items(&items, &skin, templates.clone());
    let levels: MenuLevelStack = Arc::new(Mutex::new(vec![(items, egui::Pos2::ZERO, root_size.x)]));

    // On the show() path (no anchor): set by the CursorMoved message handler
    // (physical → logical via scale_factor). We wait up to a short deadline for
    // this before committing the root position.
    let cursor_hint: Arc<Mutex<Option<egui::Pos2>>> = Arc::new(Mutex::new(None));

    // Shared flag so both the render closure and the poll loop can trigger dismissal.
    let dismiss = Arc::new(AtomicBool::new(false));

    // Pending click ID: written by the egui render closure, drained by the poll loop.
    let pending_click: Arc<Mutex<Option<(String, bool)>>> = Arc::new(Mutex::new(None));

    // Stays false while we're waiting for the compositor to report cursor position;
    // set to true once the root position is committed (so we don't flash at (0,0)).
    let render_ready = Arc::new(AtomicBool::new(false));

    // Tracks when the cursor last left all open menu areas; used to auto-close
    // the deepest submenu after a short idle period.
    let submenu_idle_since: Arc<Mutex<Option<std::time::Instant>>> = Arc::new(Mutex::new(None));

    let builder = menu_viewport_builder()
        .with_inner_size(egui::Vec2::new(OVERLAY_W, OVERLAY_H))
        .with_position(egui::Pos2::ZERO);

    let (ctx, window_id) = app
        .create_egui_window(ViewportId::from_hash_of(random_string(10)), builder, {
            let levels = levels.clone();
            let dismiss = dismiss.clone();
            let render_ready = render_ready.clone();
            let submenu_idle_since = submenu_idle_since.clone();
            let skin = skin.clone();
            let pending_click_for_closure = pending_click.clone();
            move |ctx| {
                if !render_ready.load(Ordering::Relaxed) || dismiss.load(Ordering::Relaxed) {
                    return;
                }

                // Transparent background + dark visuals so the menu Areas
                // look correct and the area behind them is fully invisible.
                ctx.set_visuals(egui::Visuals {
                    panel_fill: Color32::TRANSPARENT,
                    window_shadow: egui::Shadow::NONE,
                    ..egui::Visuals::light()
                });

                egui::CentralPanel::default()
                    .frame(egui::Frame::new().fill(egui::Color32::TRANSPARENT))
                    .show(ctx, |_ui| {});

                let mut levels_guard = levels.lock().unwrap();

                // Collect all open area rects for click-outside detection.
                let mut area_rects: Vec<egui::Rect> = Vec::new();

                // Pending submenu: set when a child-item is hovered.
                let mut pending_submenu: Option<(usize, egui::Pos2, Arc<Vec<MenuItem>>)> = None;
                // Which depth had any hovered item this frame.
                let mut hovered_at_depth: Option<usize> = None;
                // Whether the trigger item for the currently deepest submenu is hovered.
                let mut trigger_item_hovered = false;

                for depth in 0..levels_guard.len() {
                    let (level_items, level_pos, level_width) = {
                        let lv = &levels_guard[depth];
                        (lv.0.clone(), lv.1, lv.2)
                    };

                    let area_id = egui::Id::new(("wayland_menu_level", depth));
                    let area_resp = egui::Area::new(area_id)
                        .fixed_pos(level_pos)
                        .order(egui::Order::Foreground)
                        .show(ctx, |ui| {
                            egui::Frame::popup(ui.style())
                                .inner_margin(Margin::ZERO)
                                .fill(Color32::WHITE)
                                .show(ui, |ui| {
                                    ui.set_width(level_width);
                                    ui.style_mut().interaction.selectable_labels = false;
                                    ui.style_mut().spacing.item_spacing.y = 0.0;

                                    let mut handle_click = |id: String, close: bool| {
                                        *pending_click_for_closure.lock().unwrap() =
                                            Some((id, close));
                                    };
                                    let overrides_guard = item_overrides.read().unwrap();
                                    draw_menu_items(
                                        ui,
                                        &level_items,
                                        &skin,
                                        &templates,
                                        &overrides_guard,
                                        |_idx, effective_item, response| {
                                            if response.hovered() {
                                                hovered_at_depth = Some(depth);
                                                if let Some(children) = &effective_item.children {
                                                    let sub_pos = egui::Pos2::new(
                                                        response.rect.right(),
                                                        response.rect.top(),
                                                    );
                                                    trigger_item_hovered = true;
                                                    pending_submenu =
                                                        Some((depth, sub_pos, children.clone()));
                                                }
                                                return Some(HOVER_FILL);
                                            }
                                            if response.is_pointer_button_down_on() {
                                                return Some(PRESS_FILL);
                                            }
                                            None
                                        },
                                        &mut handle_click,
                                    );
                                });
                        });
                    area_rects.push(area_resp.response.rect);
                }

                // Apply submenu state changes after the draw loop.
                if let Some((parent_depth, sub_pos, children)) = pending_submenu {
                    // A child item is hovered → open/maintain its submenu.
                    levels_guard.truncate(parent_depth + 1);
                    let sub_width = measure_items(&children, &skin, templates.clone()).x;
                    levels_guard.push((children, sub_pos, sub_width));
                } else if let Some(depth) = hovered_at_depth {
                    // A non-child item is hovered → close all levels below it.
                    levels_guard.truncate(depth + 1);
                }

                // Ensure the deepest menu level is always drawn on top.
                // egui auto-promotes an Area when clicked (`is_pointer_button_down_on`),
                // which would otherwise let a parent menu cover its submenu.
                let deepest = levels_guard.len().saturating_sub(1);
                ctx.move_to_top(egui::LayerId::new(
                    egui::Order::Foreground,
                    egui::Id::new(("wayland_menu_level", deepest)),
                ));

                // Auto-close the deepest submenu when the cursor has been outside
                // both the submenu panel itself and its trigger item for a short period.
                // Hovering the parent menu's empty space does NOT keep the submenu open.
                let submenu_idle_should_tick = levels_guard.len() > 1 && {
                    let cursor_in_deepest = area_rects
                        .get(levels_guard.len() - 1)
                        .copied()
                        .map(|r| {
                            ctx.input(|i| {
                                i.pointer.hover_pos().map(|p| r.contains(p)).unwrap_or(true)
                            })
                        })
                        .unwrap_or(true);
                    !cursor_in_deepest && !trigger_item_hovered
                };
                if submenu_idle_should_tick {
                    let mut idle = submenu_idle_since.lock().unwrap();
                    match *idle {
                        None => {
                            *idle = Some(std::time::Instant::now());
                            // Keep repainting so the deadline is checked every frame.
                            ctx.request_repaint();
                        }
                        Some(t) if t.elapsed().as_millis() >= SUBMENU_IDLE_MS => {
                            let new_len = levels_guard.len() - 1;
                            levels_guard.truncate(new_len);
                            *idle = None;
                            ctx.request_repaint();
                        }
                        _ => {
                            // Timer is running; keep waking so we notice when it fires.
                            ctx.request_repaint();
                        }
                    }
                } else {
                    *submenu_idle_since.lock().unwrap() = None;
                }

                // Dismiss on click outside all open areas.
                let pointer_inside = ctx.input(|i| {
                    i.pointer
                        .hover_pos()
                        .map(|ptr| area_rects.iter().any(|r| r.contains(ptr)))
                        .unwrap_or(true) // no position data → stay open
                });
                let clicked = ctx.input(|i| i.pointer.any_click());
                if !pointer_inside && clicked {
                    dismiss.store(true, Ordering::Relaxed);
                }
            }
        })
        .await;

    // Set up the message handler immediately so CursorMoved is captured as soon
    // as the compositor sends pointer-enter (which may happen before the first frame).
    let close_requested = Arc::new(AtomicBool::new(false));
    app.set_window_message_handler(window_id, {
        let close_requested = close_requested.clone();
        let cursor_hint = cursor_hint.clone();
        move |_wid, event, win| {
            use winit::event::WindowEvent;
            match event {
                WindowEvent::CursorMoved { position, .. } => {
                    let mut hint = cursor_hint.lock().unwrap();
                    if hint.is_none() {
                        let scale = win.scale_factor() as f32;
                        *hint = Some(egui::Pos2::new(
                            position.x as f32 / scale,
                            position.y as f32 / scale,
                        ));
                    }
                }
                WindowEvent::Focused(false) | WindowEvent::CloseRequested => {
                    close_requested.store(true, Ordering::Relaxed);
                }
                _ => {}
            }
            false
        }
    })
    .await;

    // If no anchor was given, wait briefly for the compositor to report the cursor
    // position via CursorMoved. If it arrives within the deadline, use it; otherwise
    // fall back to (0, 0) — top-left.
    const DEADLINE: Duration = Duration::from_millis(50);
    let start = std::time::Instant::now();
    loop {
        if cursor_hint.lock().unwrap().is_some() {
            break; // got it
        }
        if start.elapsed() >= DEADLINE {
            break; // compositor won't give us a position; use (0,0)
        }
        smol::Timer::after(Duration::from_millis(4)).await;
    }
    // Commit: move whatever we got (or keep ZERO) into levels.
    if let Some(pos) = cursor_hint.lock().unwrap().take() {
        levels.lock().unwrap()[0].1 = pos;
    }
    // Unlock the render closure — menu is now at its final position.
    render_ready.store(true, Ordering::Relaxed);

    // Trigger repaint so the menu appears without user input.
    app.repaint_window(window_id).await;

    loop {
        if close_requested.load(Ordering::Relaxed) || dismiss.load(Ordering::Relaxed) {
            app.close_window(window_id).await;
            break;
        }
        let pending_id = pending_click.lock().unwrap().take();
        if let Some((id, should_close)) = pending_id {
            if let Some(handler) = &click_handler {
                handler(id);
            }
            if should_close {
                app.close_window(window_id).await;
                break;
            }
        }
        smol::Timer::after(Duration::from_millis(POLL_INTERVAL_MS)).await;
    }

    let _ = ctx;
}
