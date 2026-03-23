use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
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
    Click {
        id: String,
        close_all: bool,
    },
    OpenSubmenu {
        close_from: usize,
        parent_item_idx: usize,
        to_close: Vec<WindowId>,
        children: Arc<Vec<MenuItem>>,
        desired_pos: egui::Pos2,
    },
    TrimTo {
        to_close: Vec<WindowId>,
    },
}

struct LevelWindowCtx<'a> {
    app: &'a App,
    stack: &'a Arc<Mutex<MenuStack>>,
    skin: &'a Arc<crate::skin::MenuSkin>,
    templates: &'a Arc<std::collections::HashMap<String, crate::skin::ElementTemplate>>,
    item_overrides: &'a Arc<RwLock<HashMap<String, MenuItemPatch>>>,
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
    let (cursor_pos, scale, monitors) = query_cursor_info(&app).await;

    // Clamp the root position *before* creating the window so the OS places the
    // window at the correct position from the start.
    let root_pos = clamp_to_screen(cursor_pos, root_size, &monitors, scale);

    let stack: Arc<Mutex<MenuStack>> = Arc::new(Mutex::new(MenuStack {
        levels: Vec::new(),
        pending_open: None,
        pending_close_to: None,
        pending_click: None,
        dismiss: false,
        focus_lost_at: None,
    }));

    let cx = LevelWindowCtx {
        app: &app,
        stack: &stack,
        skin: &skin,
        templates: &templates,
        item_overrides: &item_overrides,
    };

    let root_window_id =
        create_level_window(&cx, 0, None, items.clone(), root_pos, root_size).await;

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
                LoopAction::Dismiss
            } else if g
                .focus_lost_at
                .is_some_and(|t| t.elapsed().as_millis() >= 150)
            {
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
                        close_from,
                        parent_item_idx: req.parent_item_idx,
                        to_close,
                        children: req.children,
                        desired_pos: req.screen_pos,
                    }
                }
            } else if let Some(close_to) = g.pending_close_to.take() {
                if close_to < g.levels.len() {
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
                let wids: Vec<WindowId> = stack
                    .lock()
                    .unwrap()
                    .levels
                    .iter()
                    .map(|l| l.window_id)
                    .collect();
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
                    let wids: Vec<WindowId> = stack
                        .lock()
                        .unwrap()
                        .levels
                        .iter()
                        .map(|l| l.window_id)
                        .collect();
                    for wid in wids {
                        app.close_window(wid).await;
                    }
                    break;
                }
            }

            LoopAction::OpenSubmenu {
                close_from,
                parent_item_idx,
                to_close,
                children,
                desired_pos,
            } => {
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

                let clamped = clamp_to_screen(sub_pos, sub_size, &monitors, scale);
                if clamped.x < sub_pos.x && sub_pos.x > parent_x {
                    sub_pos.x = parent_x - sub_size.x;
                    sub_pos = clamp_to_screen(sub_pos, sub_size, &monitors, scale);
                } else {
                    sub_pos = clamped;
                }

                create_level_window(
                    &cx,
                    close_from,
                    Some(parent_item_idx),
                    children,
                    sub_pos,
                    sub_size,
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

/// Query the cursor position directly via platform-native APIs, returning
/// logical screen pixels with Y=0 at the top-left of the primary monitor.
/// Returns `None` on failure.
fn direct_cursor_pos() -> Option<egui::Pos2> {
    // Windows ----------------------------------------------------------------
    #[cfg(target_os = "windows")]
    {
        #[repr(C)]
        struct POINT {
            x: i32,
            y: i32,
        }

        #[link(name = "User32")]
        unsafe extern "system" {
            fn GetCursorPos(lp_point: *mut POINT) -> i32;
            // Available since Windows 10 (build 14393); returns 96 on older systems.
            fn GetDpiForSystem() -> u32;
        }

        let mut pt = POINT { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut pt) } != 0 {
            // Convert physical → logical pixels using the system DPI scale.
            let scale = unsafe { GetDpiForSystem() } as f32 / 96.0;
            return Some(egui::Pos2::new(pt.x as f32 / scale, pt.y as f32 / scale));
        }
        return None;
    }

    // macOS ------------------------------------------------------------------
    #[cfg(target_os = "macos")]
    {
        #[repr(C)]
        #[derive(Copy, Clone)]
        struct CGPoint {
            x: f64,
            y: f64,
        }
        #[repr(C)]
        #[derive(Copy, Clone)]
        struct CGSize {
            width: f64,
            height: f64,
        }
        #[repr(C)]
        #[derive(Copy, Clone)]
        struct CGRect {
            origin: CGPoint,
            size: CGSize,
        }

        #[link(name = "CoreGraphics", kind = "framework")]
        #[link(name = "CoreFoundation", kind = "framework")]
        unsafe extern "C" {
            fn CGEventCreate(source: *const std::ffi::c_void) -> *mut std::ffi::c_void;
            fn CGEventGetLocation(event: *const std::ffi::c_void) -> CGPoint;
            fn CFRelease(cf: *const std::ffi::c_void);
            fn CGMainDisplayID() -> u32;
            fn CGDisplayBounds(display: u32) -> CGRect;
        }

        let ev = unsafe { CGEventCreate(std::ptr::null()) };
        if ev.is_null() {
            return None;
        }
        let pt = unsafe { CGEventGetLocation(ev) };
        unsafe { CFRelease(ev) };
        let bounds = unsafe { CGDisplayBounds(CGMainDisplayID()) };
        // CoreGraphics Y=0 is at the *bottom* of the primary monitor;
        // winit/egui expect Y=0 at the *top*, so flip.
        return Some(egui::Pos2::new(
            pt.x as f32,
            (bounds.size.height - pt.y) as f32,
        ));
    }

    // Linux X11 --------------------------------------------------------------
    // (Wayland is handled by the separate wayland module and never reaches here.)
    #[cfg(target_os = "linux")]
    {
        use std::ffi::{c_int, c_void};

        use crate::dynamic_fn;

        type XOpenDisplayFn = unsafe extern "C" fn(*const std::ffi::c_char) -> *mut c_void;
        type XCloseDisplayFn = unsafe extern "C" fn(*mut c_void) -> c_int;
        type XDefaultRootWindowFn = unsafe extern "C" fn(*mut c_void) -> u64;
        type XQueryPointerFn = unsafe extern "C" fn(
            *mut c_void,
            u64,
            *mut u64,
            *mut u64,
            *mut c_int,
            *mut c_int,
            *mut c_int,
            *mut c_int,
            *mut u32,
        ) -> c_int;

        dynamic_fn!(x_open_display, XOpenDisplayFn, "XOpenDisplay");
        dynamic_fn!(x_close_display, XCloseDisplayFn, "XCloseDisplay");
        dynamic_fn!(
            x_default_root_window,
            XDefaultRootWindowFn,
            "XDefaultRootWindow"
        );
        dynamic_fn!(x_query_pointer, XQueryPointerFn, "XQueryPointer");

        let x_open = x_open_display().ok()?;
        let x_close = x_close_display().ok()?;
        let x_root = x_default_root_window().ok()?;
        let x_query = x_query_pointer().ok()?;

        let dpy = unsafe { x_open(std::ptr::null()) };
        if dpy.is_null() {
            return None;
        }
        let root = unsafe { x_root(dpy) };
        let (mut rr, mut cr) = (0u64, 0u64);
        let (mut rx, mut ry, mut wx, mut wy, mut mask) = (0, 0, 0, 0, 0u32);
        let ok = unsafe {
            x_query(
                dpy, root, &mut rr, &mut cr, &mut rx, &mut ry, &mut wx, &mut wy, &mut mask,
            )
        };
        unsafe { x_close(dpy) };
        if ok != 0 {
            // X11 root-window coordinates are in physical pixels; on X11 setups
            // fractional scaling is rare and the effective scale is typically 1.0.
            return Some(egui::Pos2::new(rx as f32, ry as f32));
        }
        return None;
    }

    #[allow(unreachable_code)]
    None
}

async fn query_cursor_info(
    app: &App,
) -> (
    egui::Pos2,
    f32,
    Vec<(
        winit::dpi::PhysicalPosition<i32>,
        winit::dpi::PhysicalSize<u32>,
    )>,
) {
    // Always create a probe window so we can retrieve the scale factor and
    // monitor list even when the direct OS cursor query succeeds fast.
    let cursor_fallback: Arc<Mutex<Option<egui::Pos2>>> = Arc::new(Mutex::new(None));

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

    // Install CursorMoved fallback in case direct query fails.
    app.set_window_message_handler(probe_wid, {
        let cursor_fallback = cursor_fallback.clone();
        move |_wid, event, win| {
            if let winit::event::WindowEvent::CursorMoved { position, .. } = event {
                let mut c = cursor_fallback.lock().unwrap();
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

    // Fast path: direct OS cursor query.
    let direct = direct_cursor_pos();

    // If direct query failed, wait briefly for the CursorMoved fallback.
    if direct.is_none() {
        let deadline = Instant::now() + Duration::from_millis(50);
        loop {
            if cursor_fallback.lock().unwrap().is_some() {
                break;
            }
            if Instant::now() >= deadline {
                break;
            }
            smol::Timer::after(Duration::from_millis(4)).await;
        }
    }

    // Collect scale + monitor info from the probe window.
    let scale = app.get_window_scale_factor(probe_wid).await as f32;
    let monitors = app.get_monitor_rects(probe_wid).await;
    app.close_window(probe_wid).await;

    let pos = direct
        .or_else(|| *cursor_fallback.lock().unwrap())
        .unwrap_or(egui::Pos2::ZERO);

    (pos, scale.max(1.0), monitors)
}

async fn create_level_window(
    cx: &LevelWindowCtx<'_>,
    depth: usize,
    opened_from_item: Option<usize>,
    items: Arc<Vec<MenuItem>>,
    screen_pos: egui::Pos2,
    size: egui::Vec2,
) -> WindowId {
    let builder = menu_viewport_builder()
        .with_inner_size(size)
        .with_position(screen_pos);

    let (_ctx, window_id) = cx
        .app
        .create_egui_window(ViewportId::from_hash_of(random_string(10)), builder, {
            let stack = cx.stack.clone();
            let items = items.clone();
            let skin = cx.skin.clone();
            let templates = cx.templates.clone();
            let item_overrides = cx.item_overrides.clone();
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
                            guard.dismiss = true;
                        }
                    });
            }
        })
        .await;

    let focused_flag = Arc::new(AtomicBool::new(true));

    cx.app
        .set_window_message_handler(window_id, {
            let stack = cx.stack.clone();
            let focused_flag = focused_flag.clone();
            move |_wid, event, _win| {
                match event {
                    winit::event::WindowEvent::Focused(focused) => {
                        focused_flag.store(*focused, Ordering::SeqCst);
                    }
                    winit::event::WindowEvent::CloseRequested => {
                        stack.lock().unwrap().dismiss = true;
                    }
                    _ => {}
                }
                false
            }
        })
        .await;

    cx.stack.lock().unwrap().levels.push(LevelInfo {
        window_id,
        screen_pos,
        focused: focused_flag,
        opened_from_item,
    });

    window_id
}
