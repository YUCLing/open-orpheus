use egui::{ViewportBuilder, ViewportId};
use winit::{
    dpi::{LogicalSize, PhysicalPosition, PhysicalSize},
    window::{CursorIcon, WindowId},
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
    RepaintWindow(WindowId),
    RepaintViewport(ViewportId),
    RepaintAllViewports,
    CloseWindow(WindowId),
    SetWindowInnerSize(WindowId, LogicalSize<f64>),
    SetCursor(WindowId, CursorIcon),
    DragWindow(WindowId),
    GetMonitorRects(
        WindowId,
        oneshot::Sender<Vec<(PhysicalPosition<i32>, PhysicalSize<u32>)>>,
    ),
    GetWindowScaleFactor(WindowId, oneshot::Sender<Option<f64>>),
    SetWindowMessageHandler(WindowId, WindowMessageHandler),
}
