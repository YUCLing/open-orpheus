use std::{cell::OnceCell, num::NonZeroU32, sync::Arc};

use egui::{Context, ViewportBuilder, ViewportId, ahash::HashMap};
use egui_wgpu::{RendererOptions, WgpuConfiguration, winit::Painter};
use egui_winit::State;
use winit::{
    application::ApplicationHandler,
    event::WindowEvent,
    event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy},
    platform::wayland::EventLoopBuilderExtWayland,
    window::{Window, WindowId},
};

pub mod menu;

struct RunUI(Box<dyn FnMut(&Context) + Send>);

impl std::fmt::Debug for RunUI {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("RunUI").finish()
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
}

pub struct App {
    event_loop_proxy: OnceCell<EventLoopProxy<Request>>,
}

impl App {
    pub async fn new() -> Self {
        let app = App {
            event_loop_proxy: OnceCell::new(),
        };
        let (tx, rx) = oneshot::channel();
        std::thread::spawn(move || {
            let event_loop = EventLoop::<Request>::with_user_event()
                .with_any_thread(true)
                .build()
                .unwrap();
            tx.send(event_loop.create_proxy()).unwrap();
            let mut app_inner = AppInner {
                windows: HashMap::default(),
                window_states: HashMap::default(),
                window_painters: HashMap::default(),
                window_viewport_ids: HashMap::default(),
                window_run_ui: HashMap::default(),
                default_run_ui: Box::new(|_| {}),
            };
            event_loop.run_app(&mut app_inner).unwrap();
        });
        app.event_loop_proxy.set(rx.await.unwrap()).unwrap();
        app
    }

    pub async fn create_egui_window(
        &self,
        viewport_id: ViewportId,
        viewport_builder: ViewportBuilder,
        run_ui: impl FnMut(&Context) + Send + 'static,
    ) -> (Context, WindowId) {
        let ctx = Context::default();
        let (sender, receiver) = oneshot::channel();
        self.event_loop_proxy
            .get()
            .unwrap()
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
            .get()
            .unwrap()
            .send_event(Request::ShowWindow(window))
            .unwrap();
    }
}

struct AppInner {
    windows: HashMap<WindowId, Arc<Window>>,
    window_states: HashMap<WindowId, State>,
    window_painters: HashMap<WindowId, Painter>,
    window_viewport_ids: HashMap<WindowId, ViewportId>,
    window_run_ui: HashMap<WindowId, Box<dyn FnMut(&Context) + Send>>,
    default_run_ui: Box<dyn FnMut(&Context) + Send>,
}

impl ApplicationHandler<Request> for AppInner {
    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        window_id: winit::window::WindowId,
        event: winit::event::WindowEvent,
    ) {
        let Some(window) = self.windows.get(&window_id) else {
            return;
        };
        let state = self.window_states.get_mut(&window_id).unwrap();
        let res = state.on_window_event(window, &event);
        if res.repaint {
            window.request_redraw();
        }
        match event {
            WindowEvent::RedrawRequested => {
                let painter = self.window_painters.get_mut(&window_id).unwrap();

                let raw_input = state.take_egui_input(window);
                let ctx = state.egui_ctx().clone();

                let run_ui = self
                    .window_run_ui
                    .get_mut(&window_id)
                    .unwrap_or(&mut self.default_run_ui);

                let full_output = ctx.run(raw_input, run_ui);

                state.handle_platform_output(window, full_output.platform_output);

                let paint_jobs = ctx.tessellate(full_output.shapes, full_output.pixels_per_point);
                let viewport_id = self.window_viewport_ids.get(&window_id).unwrap();

                painter.paint_and_update_textures(
                    *viewport_id,
                    full_output.pixels_per_point,
                    [1.0, 1.0, 1.0, 1.0],
                    &paint_jobs,
                    &full_output.textures_delta,
                    Vec::new(),
                );
            }
            WindowEvent::CloseRequested => {
                self.windows.remove(&window_id);
                self.window_states.remove(&window_id);
                self.window_painters.remove(&window_id);
                self.window_viewport_ids.remove(&window_id);
            }
            WindowEvent::Resized(size) => {
                let painter = self.window_painters.get_mut(&window_id).unwrap();
                let viewport_id = self.window_viewport_ids.get(&window_id).unwrap();
                painter.on_window_resized(
                    *viewport_id,
                    NonZeroU32::new(size.width).unwrap(),
                    NonZeroU32::new(size.height).unwrap(),
                );
            }
            _ => {}
        }
    }

    fn resumed(&mut self, event_loop: &ActiveEventLoop) {}

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: Request) {
        match event {
            Request::CreateWindow(ctx, viewport_id, viewport_builder, run_ui, sender) => {
                let window_attributes =
                    egui_winit::create_winit_window_attributes(&ctx, viewport_builder);
                let window = Arc::new(event_loop.create_window(window_attributes).unwrap());
                let id = window.id();
                self.window_states.insert(
                    id,
                    State::new(ctx.clone(), viewport_id, &window, None, None, None),
                );
                let window_clone = window.clone();
                let painter = smol::block_on(async move {
                    let mut painter = Painter::new(
                        ctx,
                        WgpuConfiguration::default(),
                        false,
                        RendererOptions::default(),
                    )
                    .await;
                    painter
                        .set_window(viewport_id, Some(window_clone))
                        .await
                        .unwrap();
                    painter
                });
                self.window_painters.insert(id, painter);
                self.window_viewport_ids.insert(id, viewport_id);
                self.window_run_ui.insert(id, run_ui.0);
                self.windows.insert(id, window);
                sender.send(id).unwrap();
            }
            Request::ShowWindow(window_id) => {
                if let Some(window) = self.windows.get(&window_id) {
                    window.set_visible(true);
                }
            }
        }
    }
}
