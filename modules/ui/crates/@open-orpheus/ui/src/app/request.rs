use egui::{ViewportBuilder, ViewportId};
use winit::{
    dpi::{PhysicalPosition, PhysicalSize},
    window::WindowId,
};

use crate::app::wrappers::{RunUI, WindowMessageHandler};

#[derive(Debug)]
pub enum Request {
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
    GetWindowScaleFactor(WindowId, oneshot::Sender<Option<f64>>),
    SetWindowMessageHandler(WindowId, WindowMessageHandler),
}
