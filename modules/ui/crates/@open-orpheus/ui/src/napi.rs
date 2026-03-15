use libuv_sys2::uv_loop_t;
use neon::prelude::*;
use std::{
    ffi::{CStr, c_char, c_void},
    ptr,
    sync::OnceLock,
};

// N-API types
const NAPI_OK: i32 = 0;

type NapiGetUvEventLoop = unsafe extern "C" fn(*mut c_void, *mut *mut uv_loop_t) -> i32;

#[cfg(unix)]
unsafe extern "C" {
    fn dlopen(filename: *const c_char, flags: i32) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    fn dlerror() -> *const c_char;
}

#[cfg(unix)]
const RTLD_NOW: i32 = 2;

#[cfg(windows)]
unsafe extern "system" {
    fn GetModuleHandleA(lpModuleName: *const u8) -> *mut c_void;
    fn GetProcAddress(hModule: *mut c_void, lpProcName: *const u8) -> *mut c_void;
    fn GetLastError() -> u32;
}

fn resolve_napi_get_uv_event_loop() -> Result<NapiGetUvEventLoop, String> {
    #[cfg(unix)]
    unsafe {
        // NULL means "main program" on POSIX; Node/Electron exports live there.
        let handle = dlopen(ptr::null(), RTLD_NOW);
        if handle.is_null() {
            let err = dlerror();
            let msg = if err.is_null() {
                "unknown dlopen error".to_string()
            } else {
                CStr::from_ptr(err).to_string_lossy().into_owned()
            };
            return Err(format!(
                "failed to open current process for symbol lookup: {msg}"
            ));
        }

        let symbol = dlsym(
            handle,
            b"napi_get_uv_event_loop\0".as_ptr().cast::<c_char>(),
        );
        if symbol.is_null() {
            let err = dlerror();
            let msg = if err.is_null() {
                "symbol not found".to_string()
            } else {
                CStr::from_ptr(err).to_string_lossy().into_owned()
            };
            return Err(format!("failed to resolve napi_get_uv_event_loop: {msg}"));
        }

        return Ok(std::mem::transmute::<*mut c_void, NapiGetUvEventLoop>(
            symbol,
        ));
    }

    #[cfg(windows)]
    unsafe {
        let module = GetModuleHandleA(ptr::null());
        if module.is_null() {
            return Err(format!(
                "failed to get current process module: {}",
                GetLastError()
            ));
        }

        let symbol = GetProcAddress(module, b"napi_get_uv_event_loop\0".as_ptr());
        if symbol.is_null() {
            return Err(format!(
                "failed to resolve napi_get_uv_event_loop: {}",
                GetLastError()
            ));
        }

        return Ok(std::mem::transmute::<*mut c_void, NapiGetUvEventLoop>(
            symbol,
        ));
    }

    #[allow(unreachable_code)]
    Err("unsupported platform for napi_get_uv_event_loop resolution".to_string())
}

fn napi_get_uv_event_loop_fn() -> Result<NapiGetUvEventLoop, String> {
    static RESOLVED: OnceLock<Result<NapiGetUvEventLoop, String>> = OnceLock::new();
    RESOLVED.get_or_init(resolve_napi_get_uv_event_loop).clone()
}

pub fn get_uv_loop_from_neon(cx: &mut Cx) -> Result<*mut uv_loop_t, String> {
    let napi_get_uv_event_loop = napi_get_uv_event_loop_fn()?;
    let env = cx.to_raw() as *mut c_void;
    let mut loop_ptr: *mut uv_loop_t = ptr::null_mut();
    let status = unsafe { napi_get_uv_event_loop(env, &mut loop_ptr) };
    if status != NAPI_OK || loop_ptr.is_null() {
        return Err("napi_get_uv_event_loop failed".to_string());
    }
    Ok(loop_ptr)
}
