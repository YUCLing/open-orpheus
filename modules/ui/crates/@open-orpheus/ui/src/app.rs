use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use egui::{Context, ViewportBuilder, ViewportId, ahash::HashMap};
use egui_wgpu::{RendererOptions, WgpuConfiguration, winit::Painter};
use winit::{
    dpi::{PhysicalPosition, PhysicalSize},
    event::WindowEvent,
    event_loop::{EventLoop, EventLoopProxy},
    window::{Window, WindowId},
};

use crate::app::{
    fonts::get_font_definitions,
    inner::AppInner,
    request::Request,
    wrappers::{RunUI, WindowMessageHandler},
};
use crate::resource::ResourceHandler;
use crate::skin::{MenuSkin, parse_menu_skin};

mod fonts;
mod inner;
mod pack_loader;
mod request;
mod wrappers;

pub use wrappers::AppEventLoop;

#[derive(Clone)]
pub struct App {
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
    ) -> (Self, AppEventLoop) {
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

        (
            App {
                event_loop_proxy,
                ctx,
                #[cfg(target_os = "linux")]
                is_wayland,
                resource_handler,
                menu_skin: None,
            },
            AppEventLoop::new(event_loop, app_inner),
        )
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

    /// Returns the device-pixel ratio (physical pixels per logical pixel) for
    /// the given window, or `1.0` if the window no longer exists.
    pub async fn get_window_scale_factor(&self, window: WindowId) -> f64 {
        let (tx, rx) = oneshot::channel();
        self.event_loop_proxy
            .send_event(Request::GetWindowScaleFactor(window, tx))
            .unwrap();
        rx.await.ok().flatten().unwrap_or(1.0)
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
