use std::{num::NonZeroU32, sync::Arc};

use egui::{Context, ViewportId, ViewportInfo, ahash::HashMap};
use egui_wgpu::winit::Painter;
use egui_winit::State;
use winit::{
    application::ApplicationHandler,
    event::WindowEvent,
    event_loop::ActiveEventLoop,
    window::{Window, WindowId},
};

use crate::app::{
    request::Request,
    wrappers::{RunUI, WindowMessageHandler},
};

pub struct WindowState {
    window: Arc<Window>,
    viewport_id: ViewportId,
    egui_state: State,
    run_ui: RunUI,
    message_handler: Option<WindowMessageHandler>,
    viewport_info: ViewportInfo,
}

pub struct AppInner {
    pub windows: HashMap<WindowId, WindowState>,
    pub ctx: Context,
    pub painter: Option<Painter>,
    /// Tracks the last window that received a `Resized` event so the painter can
    /// be notified when the resize phase ends (macOS CoreAnimation sync).
    pub last_resized_window: Option<WindowId>,
}

impl ApplicationHandler<Request> for AppInner {
    fn window_event(
        &mut self,
        _event_loop: &ActiveEventLoop,
        window_id: winit::window::WindowId,
        event: winit::event::WindowEvent,
    ) {
        // macOS CoreAnimation resize sync: on any event following a resize, notify
        // the painter that the resize phase has ended so it can flush pending frames.
        if self.last_resized_window == Some(window_id) {
            if let (Some(ws), Some(painter)) = (self.windows.get(&window_id), &mut self.painter) {
                painter.on_window_resize_state_change(ws.viewport_id, false);
            }
            self.last_resized_window = None;
        }

        let Some(window_state) = self.windows.get_mut(&window_id) else {
            return;
        };
        let window = &window_state.window;
        if let Some(handler) = window_state.message_handler.as_mut()
            && handler.0(window_id, &event, window)
        {
            return;
        }
        let state = &mut window_state.egui_state;
        let res = state.on_window_event(window, &event);
        if res.repaint && !matches!(event, WindowEvent::RedrawRequested) {
            window.request_redraw();
        }
        match event {
            WindowEvent::RedrawRequested => {
                let Some(painter) = &mut self.painter else {
                    return;
                };
                let viewport_id = window_state.viewport_id;

                // Update viewport info (focus, size, DPI, etc.) before taking egui input
                // so that ctx.input(|i| i.viewport()) returns accurate data this frame.
                egui_winit::update_viewport_info(
                    &mut window_state.viewport_info,
                    state.egui_ctx(),
                    window,
                    false,
                );

                smol::block_on(painter.set_window(viewport_id, Some(window.clone()))).ok();

                let mut raw_input = state.take_egui_input(window);
                let ctx = state.egui_ctx().clone();

                raw_input
                    .viewports
                    .insert(viewport_id, window_state.viewport_info.clone());

                let egui::FullOutput {
                    platform_output,
                    textures_delta,
                    shapes,
                    pixels_per_point,
                    viewport_output,
                } = ctx.run(raw_input, window_state.run_ui.0.as_mut());

                state.handle_platform_output(window, platform_output);

                for (id, vp_out) in viewport_output {
                    if id == viewport_id {
                        let mut actions_requested = vec![];
                        egui_winit::process_viewport_commands(
                            &ctx,
                            &mut window_state.viewport_info,
                            vp_out.commands,
                            window,
                            &mut actions_requested,
                        );
                        // actions_requested (e.g. Screenshot) are not currently handled
                    }
                }

                // Skip GPU work for minimized windows.
                let is_visible = window_state.viewport_info.minimized != Some(true);
                if is_visible {
                    let paint_jobs = ctx.tessellate(shapes, pixels_per_point);
                    painter.paint_and_update_textures(
                        viewport_id,
                        pixels_per_point,
                        [0.0, 0.0, 0.0, 0.0],
                        &paint_jobs,
                        &textures_delta,
                        Vec::new(),
                    );
                }

                // Prevent CPU spin on macOS when the window is minimized.
                #[cfg(target_os = "macos")]
                if window.is_minimized() == Some(true) {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }
            WindowEvent::CloseRequested => {
                if let Some(ws) = self.windows.remove(&window_id) {
                    // Release the wgpu surface for this viewport only.
                    if let Some(painter) = &mut self.painter {
                        smol::block_on(painter.set_window(ws.viewport_id, None)).ok();
                    }
                    if self.windows.is_empty()
                        && let Some(mut painter) = self.painter.take()
                    {
                        painter.destroy();
                    }
                }
            }
            WindowEvent::Resized(size) => {
                let Some(w) = NonZeroU32::new(size.width) else {
                    return;
                };
                let Some(h) = NonZeroU32::new(size.height) else {
                    return;
                };
                let Some(window_state) = self.windows.get_mut(&window_id) else {
                    return;
                };
                let viewport_id = window_state.viewport_id;
                if let Some(painter) = &mut self.painter {
                    painter.on_window_resized(viewport_id, w, h);
                    // Mark this viewport as being in a resize phase; the painter uses
                    // this on macOS to synchronise with CoreAnimation transactions.
                    painter.on_window_resize_state_change(viewport_id, true);
                }
                // NLL: window_state borrow ends here; self fields are accessible again.
                self.last_resized_window = Some(window_id);
            }
            _ => {}
        }
    }

    fn resumed(&mut self, _event_loop: &ActiveEventLoop) {}

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: Request) {
        match event {
            Request::CreateWindow(viewport_id, viewport_builder, run_ui, sender) => {
                let ctx = self.ctx.clone();
                let window_attributes =
                    egui_winit::create_winit_window_attributes(&ctx, viewport_builder);
                let window = Arc::new(event_loop.create_window(window_attributes).unwrap());
                let id = window.id();

                smol::block_on(
                    self.painter
                        .as_mut()
                        .unwrap()
                        .set_window(viewport_id, Some(window.clone())),
                )
                .unwrap();

                // Setup viewport info.
                let mut viewport_info = ViewportInfo::default();
                egui_winit::update_viewport_info(&mut viewport_info, &ctx, &window, true);
                let window_state = WindowState {
                    egui_state: State::new(ctx, viewport_id, &window, None, None, None),
                    window,
                    viewport_id,
                    run_ui,
                    message_handler: None,
                    viewport_info,
                };
                self.windows.insert(id, window_state);
                sender.send(id).unwrap();
            }
            Request::RepaintViewport(viewport_id) => {
                if let Some(ws) = self
                    .windows
                    .values()
                    .find(|ws| ws.viewport_id == viewport_id)
                {
                    ws.window.request_redraw();
                }
            }
            Request::ShowWindow(window_id) => {
                if let Some(window_state) = self.windows.get(&window_id) {
                    window_state.window.set_visible(true);
                }
            }
            Request::RepaintWindow(window_id) => {
                if let Some(window_state) = self.windows.get(&window_id) {
                    window_state.window.request_redraw();
                }
            }
            Request::RepaintAllViewports => {
                for ws in self.windows.values() {
                    ws.window.request_redraw();
                }
            }
            Request::CloseWindow(window_id) => {
                if let Some(ws) = self.windows.remove(&window_id) {
                    // Release the wgpu surface for this viewport only.
                    // The shared Painter itself stays alive for other windows.
                    if let Some(painter) = &mut self.painter {
                        smol::block_on(painter.set_window(ws.viewport_id, None)).ok();
                    }
                }
            }
            Request::SetWindowMessageHandler(window_id, handler) => {
                if let Some(window_state) = self.windows.get_mut(&window_id) {
                    window_state.message_handler = Some(handler);
                }
            }
            Request::GetWindowOuterRect(window_id, sender) => {
                let result = self.windows.get(&window_id).and_then(|ws| {
                    let pos = ws.window.outer_position().ok()?;
                    let size = ws.window.outer_size();
                    Some((pos, size))
                });
                let _ = sender.send(result);
            }
            Request::GetWindowScaleFactor(window_id, sender) => {
                let factor = self
                    .windows
                    .get(&window_id)
                    .map(|ws| ws.window.scale_factor());
                let _ = sender.send(factor);
            }
            Request::GetMonitorRects(window_id, sender) => {
                let rects = self
                    .windows
                    .get(&window_id)
                    .map(|ws| {
                        ws.window
                            .available_monitors()
                            .map(|m| {
                                let pos = m.position();
                                let size = m.size();
                                (pos, size)
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let _ = sender.send(rects);
            }
        }
    }
}
