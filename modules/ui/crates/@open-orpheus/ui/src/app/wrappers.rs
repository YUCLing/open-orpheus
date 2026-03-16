use std::thread::ThreadId;

use egui::Context;
use winit::{
    event::WindowEvent,
    event_loop::EventLoop,
    window::{Window, WindowId},
};

use crate::app::{AppInner, Request};

pub struct RunUI(pub Box<dyn FnMut(&Context) + Send>);

pub struct WindowMessageHandler(pub Box<dyn FnMut(WindowId, &WindowEvent, &Window) -> bool + Send>);

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
pub struct EventLoopWrapper(usize, ThreadId);

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
