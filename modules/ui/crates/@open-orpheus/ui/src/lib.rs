use std::{ffi::c_void, sync::Arc};

use egui::{ViewportBuilder, ViewportId};
use libuv_sys2::{uv_close, uv_handle_t, uv_timer_init, uv_timer_start, uv_timer_stop, uv_timer_t};
use neon::{
    event::Channel,
    handle::{Handle, Root},
    object::Object,
    prelude::{Context, Cx},
    result::JsResult,
    types::{
        JsArray, JsBuffer, JsFunction, JsObject, JsPromise, buffer::TypedArray, extract::Json,
    },
};

use crate::{
    app::App,
    components::menu::{Menu, MenuData},
    resource::ResourceHandler,
};

mod app;
mod components;
mod napi;
mod resource;
mod skin;
mod util;

// Use #[neon::export] to export Rust functions as JavaScript functions.
// See more at: https://docs.rs/neon/latest/neon/attr.export.html

/// Bridges a JS async function (`(path: string) => Promise<Buffer>`) to a
/// `Send + Sync` Rust closure that returns a `Send` future.
///
/// Thread-safety notes:
///   - `Root<JsFunction>` is `Send + Sync`: it is a persistent V8 reference
///     that can be shared across threads; actual use only happens on the JS
///     thread inside `channel.send()`.
///   - `Channel` is `Clone + Send + Sync`: it is the safe door back to the JS
///     thread.
///   - `JsPromise::to_future` registers a native continuation and returns a
///     `JoinHandle<O>` that resolves when the Promise settles. It is `Send`,
///     so it is safe to await from any thread.
fn js_pack_handler(
    func: Arc<Root<JsFunction>>,
    channel: Channel,
) -> impl Fn(&str) -> std::pin::Pin<Box<dyn Future<Output = Vec<u8>> + Send>> + Send + Sync + 'static
{
    move |path: &str| {
        let path = path.to_owned();
        let func = func.clone();
        let channel = channel.clone();
        Box::pin(async move {
            // Schedule on the JS thread: call the JS function and attach a
            // native continuation via `to_future`. `channel.send` returns a
            // `JoinHandle` for the closure's return value, giving us a
            // `JoinHandle<JoinHandle<Vec<u8>>>` that we double-await.
            let outer = channel.send(move |mut cx| {
                let func = func.to_inner(&mut cx);
                let path_arg = cx.string(&path);
                let promise = func
                    .call_with(&cx)
                    .arg(path_arg)
                    .apply::<JsPromise, _>(&mut cx)?;
                promise.to_future(&mut cx, |mut cx, result| {
                    let bytes = match result {
                        Ok(val) => val
                            .downcast::<JsBuffer, _>(&mut cx)
                            .map(|b| TypedArray::as_slice(&*b, &cx).to_vec())
                            .unwrap_or_default(),
                        Err(_) => Vec::new(),
                    };
                    Ok(bytes)
                })
            });
            match outer.await {
                Ok(inner) => inner.await.unwrap_or_default(),
                Err(_) => Vec::new(),
            }
        })
    }
}

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
fn create_app<'cx>(mut cx: &mut Cx<'cx>, options: Handle<JsObject>) -> JsResult<'cx, JsArray> {
    let prefer_wayland = options.prop(cx, "preferWayland").get()?;
    let read_web_pack = options
        .prop(cx, "readWebPack")
        .get::<Handle<JsFunction>>()?
        .root(cx);
    let read_skin_pack = options
        .prop(cx, "readSkinPack")
        .get::<Handle<JsFunction>>()?
        .root(cx);
    let menu_skin_xml: Handle<JsBuffer> = options.prop(cx, "menuSkinXml").get()?;
    let menu_skin_xml = TypedArray::as_slice(&*menu_skin_xml, cx).to_vec();

    let channel = cx.channel();
    let resource_handler = ResourceHandler::new(
        js_pack_handler(Arc::new(read_web_pack), channel.clone()),
        js_pack_handler(Arc::new(read_skin_pack), channel),
    );

    let app = App::new(prefer_wayland, resource_handler, &menu_skin_xml);
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

/// Creates a `Menu` and returns an opaque pointer to it.
#[neon::export]
fn create_menu(app_ptr: f64, menu_data: Json<MenuData>) -> f64 {
    let app = unsafe { &*(app_ptr as usize as *mut App) };
    let menu = Box::new(Menu::new(app, menu_data.0));
    Box::into_raw(menu) as usize as f64
}

/// Shows the menu referenced by `menu_ptr`.
#[neon::export]
fn show_menu(menu_ptr: f64) {
    let menu = unsafe { &*(menu_ptr as usize as *const Menu) };
    menu.show();
}

/// Registers a JS callback fired whenever a menu item is clicked.
/// The callback receives the item's `menu_id` (text rows) or button
/// `id` (icon-button rows) as its first argument.
#[neon::export]
fn set_menu_on_click<'cx>(cx: &mut Cx<'cx>, menu_ptr: f64, callback: Handle<'cx, JsFunction>) {
    let menu = unsafe { &mut *(menu_ptr as usize as *mut Menu) };
    let callback: Arc<Root<JsFunction>> = Arc::new(callback.root(cx));
    let channel = cx.channel();
    menu.set_click_handler(move |id| {
        let callback = callback.clone();
        let channel = channel.clone();
        let id = id.to_owned();
        channel.send(move |mut cx| {
            let cb = callback.to_inner(&mut cx);
            let id_arg = cx.string(&id);
            cb.call_with(&cx).arg(id_arg).exec(&mut cx)?;
            Ok(())
        });
    });
}

// Use #[neon::main] to add additional behavior at module loading time.
// See more at: https://docs.rs/neon/latest/neon/attr.main.html

// #[neon::main]
// fn main(_cx: ModuleContext) -> NeonResult<()> {
//     println!("module is loaded!");
//     Ok(())
// }
