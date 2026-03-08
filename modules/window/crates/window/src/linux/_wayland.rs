use std::{env, ffi::{c_char, c_int, c_void}, mem, sync::OnceLock};

use ilhook::x64::{CallbackOption, HookFlags, HookType, Hooker, Registers};
use libc::{RTLD_DEFAULT};

use crate::linux::dl::{dlclose, dlerror, dlopen, dlsym};

static IS_WAYLAND: OnceLock<bool> = OnceLock::new();
static WL_PROXY_GET_CLASS: OnceLock<extern "C" fn(*mut c_void) -> *const c_char> = OnceLock::new();
static WL_PROXY_GET_INTERFACE: OnceLock<extern "C" fn(*mut c_void) -> *const c_char> = OnceLock::new();
static WL_POINTER_INTERFACE: OnceLock<usize> = OnceLock::new();
static ORIGINAL_POINTER_BUTTON_HANDLER: OnceLock<extern "C" fn(data: *mut c_void, pointer: *mut c_void, serial: u32, time: u32, button: u32, state: u32)> = OnceLock::new();

#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct pointer_listener {
    enter: Option<extern "C" fn(data: *mut c_void, pointer: *mut c_void, serial: u32, surface: *mut c_void, surface_x: f64, surface_y: f64)>,
    leave: Option<extern "C" fn(data: *mut c_void, pointer: *mut c_void, serial: u32, surface: *mut c_void)>,
    motion: Option<extern "C" fn(data: *mut c_void, pointer: *mut c_void, time: u32, surface_x: f64, surface_y: f64)>,
    button: Option<extern "C" fn(data: *mut c_void, pointer: *mut c_void, serial: u32, time: u32, button: u32, state: u32)>,
    axis: Option<extern "C" fn(data: *mut c_void, pointer: *mut c_void, time: u32, axis: u32, value: f64)>,
    frame: Option<extern "C" fn(data: *mut c_void, pointer: *mut c_void)>,
    axis_source: Option<extern "C" fn(data: *mut c_void, pointer: *mut c_void, axis_source: u32)>,
    axis_stop: Option<extern "C" fn(data: *mut c_void, pointer: *mut c_void, time: u32, axis: u32)>,
    axis_discrete: Option<extern "C" fn(data: *mut c_void, pointer: *mut c_void, axis: u32, discrete: i32)>,
}

extern "C" fn on_pointer_button(data: *mut c_void, pointer: *mut c_void, serial: u32, time: u32, button: u32, state: u32) {
    println!("Pointer button event: serial={}, time={}, button={}, state={}", serial, time, button, state);
    if let Some(orig) = ORIGINAL_POINTER_BUTTON_HANDLER.get() {
        orig(data, pointer, serial, time, button, state);
    }
}

unsafe extern "win64" fn on_wl_display_connect(_: *mut Registers, _: usize, _: usize) -> usize {
    IS_WAYLAND.set(true).ok();
    let a = 0;
    a as usize
}

unsafe extern "win64" fn on_wl_proxy_add_listener(reg: *mut Registers, ori_func_ptr: usize, _: usize) -> usize {
    let wl_proxy_add_listener: extern "C" fn(*mut c_void, *const c_void, *mut c_void) -> c_int =
        unsafe { mem::transmute(ori_func_ptr) };
    let proxy = unsafe { (*reg).rdi } as *mut c_void; // First argument in RDI
    let listener = unsafe { (*reg).rsi } as *const c_void; // Second argument in RSI
    let data = unsafe { (*reg).rdx } as *mut c_void; // Third argument in RDX
    let class = WL_PROXY_GET_CLASS.get().unwrap()(proxy);
    if let (Some(wl_proxy_get_interface), Some(wl_pointer_interface)) = (WL_PROXY_GET_INTERFACE.get(), WL_POINTER_INTERFACE.get()) {
        let iface = wl_proxy_get_interface(proxy);
        if iface == *wl_pointer_interface as *const c_char {
            let original = unsafe { *(listener as *const pointer_listener) };
            let mut new_listener = Box::new(pointer_listener {
                enter: None,
                leave: None,
                motion: None,
                button: Some(on_pointer_button),
                axis: None,
                frame: None,
                axis_source: None,
                axis_stop: None,
                axis_discrete: None,
            });
            if let Some(orig) = original.button {
                ORIGINAL_POINTER_BUTTON_HANDLER.set(orig).ok();
            }
            let persistent = Box::leak(new_listener) as *const pointer_listener as *const c_void;
            let ret = wl_proxy_add_listener(proxy, persistent, data);
            println!("Modified return {}", ret);
            return ret as usize;
        }
    }
    let ret = wl_proxy_add_listener(proxy, listener, data);
    ret as usize
}

#[neon::export]
fn is_wayland() -> bool {
    *IS_WAYLAND.get().unwrap_or(&false)
}

pub(super) fn init_wayland_hook() {
    unsafe {
                let wl_display_connect_addr = dlsym(RTLD_DEFAULT, c"wl_display_connect".as_ptr());
        if wl_display_connect_addr.is_null() {
            eprintln!("Failed to find symbol wl_display_connect: {:?}", std::ffi::CStr::from_ptr(dlerror()));
            return;
        }
        println!("Found wl_display_connect at {:x}", wl_display_connect_addr as usize);

        let wl_proxy_add_listener_addr = dlsym(RTLD_DEFAULT, c"wl_proxy_add_listener".as_ptr());
        if wl_proxy_add_listener_addr.is_null() {
            eprintln!("Failed to find symbol wl_proxy_add_listener: {:?}", std::ffi::CStr::from_ptr(dlerror()));
            return;
        }
        println!("Found wl_proxy_add_listener at {:x}", wl_proxy_add_listener_addr as usize);

        let wl_display_dispatch_queue_addr = dlsym(RTLD_DEFAULT, c"wl_display_dispatch_queue".as_ptr());
        if wl_display_dispatch_queue_addr.is_null() {
            eprintln!("Failed to find symbol wl_display_dispatch_queue: {:?}", std::ffi::CStr::from_ptr(dlerror()));
            return;
        }
        println!("Found wl_display_dispatch_queue at {:x}", wl_display_dispatch_queue_addr as usize);

        let wl_proxy_get_class_addr = dlsym(RTLD_DEFAULT, c"wl_proxy_get_class".as_ptr());
        if wl_proxy_get_class_addr.is_null() {
            eprintln!("Failed to find symbol wl_proxy_get_class: {:?}", std::ffi::CStr::from_ptr(dlerror()));
            return;
        }
        println!("Found wl_proxy_get_class at {:x}", wl_proxy_get_class_addr as usize);
        WL_PROXY_GET_CLASS.set(mem::transmute(wl_proxy_get_class_addr)).unwrap();

        let wl_proxy_get_interface_addr = dlsym(RTLD_DEFAULT, c"wl_proxy_get_interface".as_ptr());
        if wl_proxy_get_interface_addr.is_null() {
            eprintln!("Failed to find symbol wl_proxy_get_interface: {:?}", std::ffi::CStr::from_ptr(dlerror()));
            return;
        }
        println!("Found wl_proxy_get_interface at {:x}", wl_proxy_get_interface_addr as usize);
        WL_PROXY_GET_INTERFACE.set(mem::transmute(wl_proxy_get_interface_addr)).unwrap();

        let wl_pointer_interface_addr = dlsym(RTLD_DEFAULT, c"wl_pointer_interface".as_ptr());
        if wl_pointer_interface_addr.is_null() {
            eprintln!("Failed to find symbol wl_pointer_interface: {:?}", std::ffi::CStr::from_ptr(dlerror()));
            return;
        }
        println!("Found wl_pointer_interface at {:x}", wl_pointer_interface_addr as usize);
        WL_POINTER_INTERFACE.set(wl_pointer_interface_addr as usize).unwrap();

        let hook = Hooker::new(wl_display_connect_addr as usize, HookType::Retn(on_wl_display_connect), CallbackOption::None, 0, HookFlags::empty());
        let _ = Box::into_raw(Box::new(hook.hook().unwrap())); // Leak the hook to keep it alive for the lifetime of the process

                let hook = Hooker::new(wl_display_dispatch_queue_addr as usize, HookType::Retn(on_wl_display_connect), CallbackOption::None, 0, HookFlags::empty());
        let _ = Box::into_raw(Box::new(hook.hook().unwrap())); // Leak the hook to keep it alive for the lifetime of the process

        let hook = Hooker::new(wl_proxy_add_listener_addr as usize, HookType::Retn(on_wl_proxy_add_listener), CallbackOption::None, 0, HookFlags::empty());
        let _ = Box::into_raw(Box::new(hook.hook().unwrap())); // Leak the hook to keep it alive for the lifetime of the process
    }
}
