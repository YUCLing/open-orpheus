use std::{
    num::NonZeroU32,
    sync::{Arc, Mutex},
    time::Duration,
};

use egui::{Context, ViewportBuilder, ViewportId, ViewportInfo, ahash::HashMap};
use egui_wgpu::{RendererOptions, WgpuConfiguration, winit::Painter};
use egui_winit::State;
use winit::{
    application::ApplicationHandler,
    dpi::{PhysicalPosition, PhysicalSize},
    event::WindowEvent,
    event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy},
    platform::pump_events::EventLoopExtPumpEvents,
    window::{Window, WindowId},
};

use crate::app::{
    fonts::get_font_definitions,
    wrappers::{EventLoopWrapper, RunUI, WindowMessageHandler},
};
use crate::resource::ResourceHandler;
use crate::skin::{MenuSkin, parse_menu_skin};

mod fonts;
mod pack_loader;
mod wrappers;

#[derive(Debug)]
enum Request {
    CreateWindow(
        ViewportId,
        ViewportBuilder,
        RunUI,
        oneshot::Sender<WindowId>,
    ),
    ShowWindow(WindowId),
    RepaintWindow(WindowId),
    RepaintViewport(ViewportId),
    RepaintAllViewports,
    CloseWindow(WindowId),
    GetWindowOuterRect(
        WindowId,
        oneshot::Sender<Option<(PhysicalPosition<i32>, PhysicalSize<u32>)>>,
    ),
    GetMonitorRects(
        WindowId,
        oneshot::Sender<Vec<(PhysicalPosition<i32>, PhysicalSize<u32>)>>,
    ),
    SetWindowMessageHandler(WindowId, WindowMessageHandler),
}

#[derive(Clone)]
pub struct App {
    /// The event loop that is used to pump events from main thead only.
    event_loop: Arc<EventLoopWrapper>,
    event_loop_proxy: EventLoopProxy<Request>,
    /// Whether the event loop is running on a Wayland compositor.
    #[cfg(target_os = "linux")]
    is_wayland: bool,
    ctx: Context,
    resource_handler: ResourceHandler,
    /// The currently loaded menu skin
    pub menu_skin: Option<Arc<MenuSkin>>,
}

impl App {
    /// `prefer_wayland`: `Some(true)` forces Wayland, `Some(false)` forces X11,
    /// `None` lets winit auto-select.
    pub fn new(
        #[cfg(target_os = "linux")] prefer_wayland: Option<bool>,
        resource_handler: ResourceHandler,
    ) -> Self {
        let mut builder = EventLoop::<Request>::with_user_event();

        #[cfg(target_os = "linux")]
        {
            use winit::platform::wayland::EventLoopBuilderExtWayland;
            use winit::platform::x11::EventLoopBuilderExtX11;
            match prefer_wayland {
                Some(true) => {
                    builder.with_wayland();
                }
                Some(false) => {
                    builder.with_x11();
                }
                None => {}
            }
        }

        let event_loop = builder.build().unwrap();
        let event_loop_proxy = event_loop.create_proxy();

        // Detect the backend that was *actually* selected by the compositor.
        #[cfg(target_os = "linux")]
        let is_wayland = {
            use raw_window_handle::{HasDisplayHandle, RawDisplayHandle};
            matches!(
                event_loop.display_handle().unwrap().as_raw(),
                RawDisplayHandle::Wayland(_)
            )
        };

        let web_pack_cache: pack_loader::PackImageCache =
            Arc::new(Mutex::new(std::collections::HashMap::new()));
        let skin_pack_cache: pack_loader::PackImageCache =
            Arc::new(Mutex::new(std::collections::HashMap::new()));

        let ctx = Self::create_context();
        ctx.add_image_loader(Arc::new(pack_loader::PackLoader::for_web_pack(
            resource_handler.clone(),
            Some(web_pack_cache.clone()),
        )));
        ctx.add_image_loader(Arc::new(pack_loader::PackLoader::for_skin_pack(
            resource_handler.clone(),
            Some(skin_pack_cache.clone()),
        )));

        let proxy_for_repaint = event_loop_proxy.clone();
        let ctx_for_repaint = ctx.clone();
        ctx.set_request_repaint_callback(move |info| {
            let proxy = proxy_for_repaint.clone();
            let viewport_id = info.viewport_id;
            if info.delay == Duration::ZERO {
                let _ = proxy.send_event(Request::RepaintViewport(viewport_id));
            } else {
                let ctx = ctx_for_repaint.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(info.delay);
                    if ctx.cumulative_pass_nr() == info.current_cumulative_pass_nr {
                        let _ = proxy.send_event(Request::RepaintViewport(viewport_id));
                    }
                });
            }
        });

        let painter = smol::block_on(Painter::new(
            ctx.clone(),
            WgpuConfiguration::default(),
            true,
            RendererOptions::default(),
        ));

        let app_inner = AppInner {
            windows: HashMap::default(),
            ctx: ctx.clone(),
            painter: Some(painter),
            last_resized_window: None,
        };

        App {
            event_loop: Arc::new(EventLoopWrapper::new(event_loop, app_inner)),
            event_loop_proxy,
            ctx,
            #[cfg(target_os = "linux")]
            is_wayland,
            resource_handler,
            menu_skin: None,
        }
    }

    pub async fn load_menu_skin(&mut self, path: &str) -> Result<(), String> {
        let data = self.resource_handler.read_skin_pack(path).await;
        self.menu_skin = Some(Arc::new(parse_menu_skin(&data)));
        Ok(())
    }

    /// Returns `true` if the underlying event loop is connected to a Wayland compositor.
    #[cfg(target_os = "linux")]
    pub fn is_wayland(&self) -> bool {
        self.is_wayland
    }

    pub fn resource_handler(&self) -> &ResourceHandler {
        &self.resource_handler
    }

    /// This MUST NOT be called from other threads.
    pub fn pump_events(&mut self) {
        let (event_loop, app_inner) = self.event_loop.get();
        let _status = event_loop.pump_app_events(Some(Duration::ZERO), app_inner);
    }

    pub fn create_context() -> Context {
        let ctx = Context::default();
        ctx.set_fonts(get_font_definitions());
        ctx
    }

    pub async fn create_egui_window(
        &self,
        viewport_id: ViewportId,
        viewport_builder: ViewportBuilder,
        run_ui: impl FnMut(&Context) + Send + 'static,
    ) -> (Context, WindowId) {
        let (sender, receiver) = oneshot::channel();
        self.event_loop_proxy
            .send_event(Request::CreateWindow(
                viewport_id,
                viewport_builder,
                RunUI(Box::new(run_ui)),
                sender,
            ))
            .unwrap();
        (self.ctx.clone(), receiver.await.unwrap())
    }

    pub async fn show_window(&self, window: WindowId) {
        // TODO: wait for window show
        self.event_loop_proxy
            .send_event(Request::ShowWindow(window))
            .unwrap();
    }

    pub async fn repaint_window(&self, window: WindowId) {
        self.event_loop_proxy
            .send_event(Request::RepaintWindow(window))
            .unwrap();
    }

    pub async fn repaint_all(&self) {
        self.event_loop_proxy
            .send_event(Request::RepaintAllViewports)
            .unwrap();
    }

    pub async fn close_window(&self, window: WindowId) {
        self.event_loop_proxy
            .send_event(Request::CloseWindow(window))
            .unwrap();
    }

    pub async fn set_window_message_handler(
        &self,
        window: WindowId,
        handler: impl FnMut(WindowId, &WindowEvent, &Window) -> bool + Send + 'static,
    ) {
        self.event_loop_proxy
            .send_event(Request::SetWindowMessageHandler(
                window,
                WindowMessageHandler(Box::new(handler)),
            ))
            .unwrap();
    }

    /// Returns the window's outer position and size in physical pixels, or
    /// `None` if the window no longer exists or the platform doesn't support it
    /// (e.g. Wayland top-level windows).
    pub async fn get_window_outer_rect(
        &self,
        window: WindowId,
    ) -> Option<(PhysicalPosition<i32>, PhysicalSize<u32>)> {
        let (tx, rx) = oneshot::channel();
        self.event_loop_proxy
            .send_event(Request::GetWindowOuterRect(window, tx))
            .unwrap();
        rx.await.ok().flatten()
    }

    /// Returns monitor geometry for all monitors as (position, size) in physical pixels,
    /// queried via the window thread using any existing window as context.
    pub async fn get_monitor_rects(
        &self,
        any_window: winit::window::WindowId,
    ) -> Vec<(PhysicalPosition<i32>, PhysicalSize<u32>)> {
        let (tx, rx) = oneshot::channel();
        if self
            .event_loop_proxy
            .send_event(Request::GetMonitorRects(any_window, tx))
            .is_err()
        {
            return vec![];
        }
        rx.await.unwrap_or_default()
    }
}

struct WindowState {
    window: Arc<Window>,
    viewport_id: ViewportId,
    egui_state: State,
    run_ui: RunUI,
    message_handler: Option<WindowMessageHandler>,
    viewport_info: ViewportInfo,
}

struct AppInner {
    windows: HashMap<WindowId, WindowState>,
    ctx: Context,
    painter: Option<Painter>,
    /// Tracks the last window that received a `Resized` event so the painter can
    /// be notified when the resize phase ends (macOS CoreAnimation sync).
    last_resized_window: Option<WindowId>,
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
        if let Some(handler) = window_state.message_handler.as_mut() {
            if handler.0(window_id, &event, window) {
                return;
            }
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
                    if self.windows.is_empty() {
                        if let Some(mut painter) = self.painter.take() {
                            painter.destroy();
                        }
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
            Request::GetMonitorRects(window_id, sender) => {
                let rects = self
                    .windows
                    .get(&window_id)
                    .map(|ws| {
                        ws.window
                            .available_monitors()
                            .filter_map(|m| {
                                let pos = m.position();
                                let size = m.size();
                                Some((pos, size))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let _ = sender.send(rects);
            }
        }
    }
}
