use std::{num::NonZeroU32, sync::Arc, thread::ThreadId, time::Duration};

use egui::{Context, Vec2, ViewportBuilder, ViewportId, ahash::HashMap};
use egui_wgpu::{RendererOptions, WgpuConfiguration, winit::Painter};
use egui_winit::State;
use winit::{
    application::ApplicationHandler,
    dpi::{LogicalPosition, PhysicalPosition, PhysicalSize},
    event::WindowEvent,
    event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy},
    platform::pump_events::EventLoopExtPumpEvents,
    window::{Window, WindowId},
};

use crate::app::fonts::get_font_definitions;

mod base64_loader;
mod fonts;

struct RunUI(Box<dyn FnMut(&Context) + Send>);

struct WindowMessageHandler(Box<dyn FnMut(WindowId, &WindowEvent, &Window) -> bool + Send>);

impl std::fmt::Debug for RunUI {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("RunUI").finish()
    }
}

impl std::fmt::Debug for WindowMessageHandler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("WindowMessageHandler").finish()
    }
}

#[derive(Clone)]
struct EventLoopWrapper(usize, ThreadId);

impl EventLoopWrapper {
    pub fn new(event_loop: EventLoop<Request>, app_inner: AppInner) -> Self {
        Self(
            Box::into_raw(Box::new((event_loop, app_inner))) as usize,
            std::thread::current().id(),
        )
    }

    pub fn get(&self) -> &mut (EventLoop<Request>, AppInner) {
        if self.1 != std::thread::current().id() {
            panic!("Trying to access event loop from other thread!");
        }
        unsafe { &mut *(self.0 as *mut (EventLoop<Request>, AppInner)) }
    }
}

impl Drop for EventLoopWrapper {
    fn drop(&mut self) {
        unsafe { drop(Box::from_raw(self.0 as *mut (EventLoop<Request>, AppInner))) }
    }
}

#[derive(Debug)]
enum Request {
    CreateWindow(
        Context,
        ViewportId,
        ViewportBuilder,
        RunUI,
        oneshot::Sender<WindowId>,
    ),
    ShowWindow(WindowId),
    RepaintWindow(WindowId),
    CloseWindow(WindowId),
    ResizeWindow(WindowId, Vec2),
    SetWindowPosition(WindowId, LogicalPosition<f64>),
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
    event_loop: Arc<EventLoopWrapper>,
    event_loop_proxy: EventLoopProxy<Request>,
    /// Whether the event loop is running on a Wayland compositor.
    /// Detected once at construction time from the actual display handle.
    is_wayland: bool,
}

impl App {
    /// `prefer_wayland`: `Some(true)` forces Wayland, `Some(false)` forces X11,
    /// `None` lets winit auto-select.
    pub async fn new(prefer_wayland: Option<bool>) -> Self {
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
        let is_wayland = {
            #[cfg(target_os = "linux")]
            {
                use raw_window_handle::{HasDisplayHandle, RawDisplayHandle};
                matches!(
                    event_loop.display_handle().unwrap().as_raw(),
                    RawDisplayHandle::Wayland(_)
                )
            }
            #[cfg(not(target_os = "linux"))]
            {
                false
            }
        };

        let app_inner = AppInner {
            windows: HashMap::default(),
        };
        App {
            event_loop: Arc::new(EventLoopWrapper::new(event_loop, app_inner)),
            event_loop_proxy,
            is_wayland,
        }
    }

    /// Returns `true` if the underlying event loop is connected to a Wayland compositor.
    pub fn is_wayland(&self) -> bool {
        self.is_wayland
    }

    /// This MUST NOT be called from other threads.
    pub fn pump_events(&mut self) {
        let (event_loop, app_inner) = self.event_loop.get();
        let _status = event_loop.pump_app_events(Some(Duration::ZERO), app_inner);
    }

    pub fn create_context() -> Context {
        let ctx = Context::default();
        ctx.add_image_loader(Arc::new(base64_loader::Base64Loader {}));
        ctx.set_fonts(get_font_definitions());
        ctx
    }

    pub async fn create_egui_window(
        &self,
        viewport_id: ViewportId,
        viewport_builder: ViewportBuilder,
        run_ui: impl FnMut(&Context) + Send + 'static,
    ) -> (Context, WindowId) {
        let ctx = Self::create_context();
        let (sender, receiver) = oneshot::channel();
        self.event_loop_proxy
            .send_event(Request::CreateWindow(
                ctx.clone(),
                viewport_id,
                viewport_builder,
                RunUI(Box::new(run_ui)),
                sender,
            ))
            .unwrap();
        (ctx, receiver.await.unwrap())
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

    pub async fn resize_window(&self, window: WindowId, size: Vec2) {
        self.event_loop_proxy
            .send_event(Request::ResizeWindow(window, size))
            .unwrap();
    }

    pub async fn set_window_position(&self, window: WindowId, pos: LogicalPosition<f64>) {
        self.event_loop_proxy
            .send_event(Request::SetWindowPosition(window, pos))
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

    /// Returns monitor geometry for all monitors as (position, size) in physical pixels,
    /// queried via the window thread using any existing window as context.
    pub async fn get_monitors(&self) -> Vec<(PhysicalPosition<i32>, PhysicalSize<u32>)> {
        vec![]
    }
}

struct WindowState {
    window: Arc<Window>,
    viewport_id: ViewportId,
    egui_state: State,
    painter: Painter,
    run_ui: RunUI,
    message_handler: Option<WindowMessageHandler>,
}

struct AppInner {
    windows: HashMap<WindowId, WindowState>,
}

impl ApplicationHandler<Request> for AppInner {
    fn window_event(
        &mut self,
        _event_loop: &ActiveEventLoop,
        window_id: winit::window::WindowId,
        event: winit::event::WindowEvent,
    ) {
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
        if res.repaint {
            window.request_redraw();
        }
        match event {
            WindowEvent::RedrawRequested => {
                let painter = &mut window_state.painter;

                let raw_input = state.take_egui_input(window);
                let ctx = state.egui_ctx().clone();

                let full_output = ctx.run(raw_input, window_state.run_ui.0.as_mut());

                state.handle_platform_output(window, full_output.platform_output);

                let paint_jobs = ctx.tessellate(full_output.shapes, full_output.pixels_per_point);
                let viewport_id = window_state.viewport_id;

                painter.paint_and_update_textures(
                    viewport_id,
                    full_output.pixels_per_point,
                    [0.0, 0.0, 0.0, 0.0],
                    &paint_jobs,
                    &full_output.textures_delta,
                    Vec::new(),
                );
            }
            WindowEvent::CloseRequested => {
                self.windows.remove(&window_id);
            }
            WindowEvent::Resized(size) => {
                let Some(window_state) = self.windows.get_mut(&window_id) else {
                    return;
                };
                let Some(w) = NonZeroU32::new(size.width) else {
                    return;
                };
                let Some(h) = NonZeroU32::new(size.height) else {
                    return;
                };
                let painter = &mut window_state.painter;
                let viewport_id = window_state.viewport_id;
                painter.on_window_resized(viewport_id, w, h);
            }
            _ => {}
        }
    }

    fn resumed(&mut self, _event_loop: &ActiveEventLoop) {}

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: Request) {
        match event {
            Request::CreateWindow(ctx, viewport_id, viewport_builder, run_ui, sender) => {
                let window_attributes =
                    egui_winit::create_winit_window_attributes(&ctx, viewport_builder);
                let window = Arc::new(event_loop.create_window(window_attributes).unwrap());
                let id = window.id();
                let window_state = WindowState {
                    window: window.clone(),
                    viewport_id,
                    egui_state: State::new(ctx.clone(), viewport_id, &window, None, None, None),
                    painter: smol::block_on(async move {
                        let mut painter = Painter::new(
                            ctx,
                            WgpuConfiguration::default(),
                            true,
                            RendererOptions::default(),
                        )
                        .await;
                        painter.set_window(viewport_id, Some(window)).await.unwrap();
                        painter
                    }),
                    run_ui,
                    message_handler: None,
                };
                self.windows.insert(id, window_state);
                sender.send(id).unwrap();
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
            Request::CloseWindow(window_id) => {
                if let Some(mut ws) = self.windows.remove(&window_id) {
                    // Explicitly release the wgpu surface before dropping the
                    // window; otherwise the GPU may still hold a reference and
                    // the driver/validation layer will crash.
                    smol::block_on(async {
                        ws.painter.set_window(ws.viewport_id, None).await.ok();
                    });
                }
            }
            Request::SetWindowMessageHandler(window_id, handler) => {
                if let Some(window_state) = self.windows.get_mut(&window_id) {
                    window_state.message_handler = Some(handler);
                }
            }
            Request::SetWindowPosition(window_id, pos) => {
                if let Some(window_state) = self.windows.get(&window_id) {
                    window_state.window.set_outer_position(pos);
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
            Request::ResizeWindow(window_id, size) => {
                if let Some(window_state) = self.windows.get(&window_id) {
                    let _ = window_state
                        .window
                        .request_inner_size(winit::dpi::LogicalSize::new(size.x, size.y));
                }
            }
        }
    }
}
