use std::ffi::c_void;

use egui::{ViewportBuilder, ViewportId};
use libuv_sys2::{uv_close, uv_handle_t, uv_timer_init, uv_timer_start, uv_timer_stop, uv_timer_t};
use neon::{
    object::Object,
    prelude::{Context, Cx},
    result::JsResult,
    types::{JsArray, extract::Json},
};

use crate::{
    app::App,
    components::menu::{Menu, MenuData},
};

mod app;
mod components;
mod napi;
mod util;

// Use #[neon::export] to export Rust functions as JavaScript functions.
// See more at: https://docs.rs/neon/latest/neon/attr.export.html

unsafe extern "C" fn on_timer(handle: *mut uv_timer_t) {
    let state_ptr = unsafe { *handle }.data as *mut App;
    if state_ptr.is_null() {
        return;
    }
    let state = unsafe { &mut *state_ptr };

    state.pump_events();
}

unsafe extern "C" fn on_close(handle: *mut uv_handle_t) {
    // The uv_timer_t is a uv_handle_t; free the handle allocation.
    let timer = handle as *mut uv_timer_t;
    drop(unsafe { Box::from_raw(timer) });
}

#[neon::export]
fn create_app<'cx>(mut cx: &mut Cx<'cx>, prefer_wayland: Option<bool>) -> JsResult<'cx, JsArray> {
    smol::block_on(async {
        let app = App::new(prefer_wayland).await;
        let loop_ptr = napi::get_uv_loop_from_neon(&mut cx).or_else(|x| cx.throw_error(x))?;
        let ptr = Box::into_raw(Box::new(app));
        let timer = Box::into_raw(Box::new(unsafe { std::mem::zeroed::<uv_timer_t>() }));
        unsafe { (*timer).data = ptr as *mut c_void };
        let rc = unsafe { uv_timer_init(loop_ptr, timer) };
        if rc != 0 {
            unsafe {
                drop(Box::from_raw(ptr));
                drop(Box::from_raw(timer));
            }
            return cx.throw_error(format!("uv_timer_init failed: {rc}"));
        }

        let rc = unsafe { uv_timer_start(timer, Some(on_timer), 0, 3) };
        if rc != 0 {
            unsafe {
                drop(Box::from_raw(ptr));
                drop(Box::from_raw(timer));
            }
            return cx.throw_error(format!("uv_timer_start failed: {rc}"));
        }
        let ret = cx.empty_array();
        let val = cx.number(ptr as usize as f64);
        ret.set(cx, 0, val)?;
        let val = cx.number(timer as usize as f64);
        ret.set(cx, 1, val)?;
        Ok(ret)
    })
}

#[neon::export]
fn destroy_app(app_ptr: f64, timer_ptr: f64) {
    let app_ptr = app_ptr as usize as *mut App;
    let timer_ptr = timer_ptr as usize as *mut uv_timer_t;
    unsafe {
        uv_timer_stop(timer_ptr);
        uv_close(timer_ptr as *mut uv_handle_t, Some(on_close));
    }
    let _app = unsafe { Box::from_raw(app_ptr) };
}

/// For testing purposes.
#[neon::export]
fn create_window(app_ptr: f64) {
    let app = unsafe { &mut *(app_ptr as usize as *mut App) };
    let viewport_id = ViewportId::from_hash_of("test");
    let viewport_builder = ViewportBuilder::default()
        .with_always_on_top()
        .with_visible(true)
        .with_title("EGUI Test");
    smol::block_on(async {
        let (_ctx, id) = app
            .create_egui_window(viewport_id, viewport_builder, |ctx| {
                egui::CentralPanel::default().show(ctx, |ui| {
                    ui.label("Hello, World!");
                });
            })
            .await;
        app.show_window(id).await;
    });
}

/// Not final API.
#[neon::export]
fn create_menu(app_ptr: f64, menu_data: Json<MenuData>) {
    let app = unsafe { &*(app_ptr as usize as *mut App) };
    Menu::new(app, menu_data.0).show();
}

// Use #[neon::main] to add additional behavior at module loading time.
// See more at: https://docs.rs/neon/latest/neon/attr.main.html

// #[neon::main]
// fn main(_cx: ModuleContext) -> NeonResult<()> {
//     println!("module is loaded!");
//     Ok(())
// }
