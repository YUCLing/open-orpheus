use libuv_sys2::uv_loop_t;
use neon::prelude::*;
use std::{ffi::c_void, ptr};

use crate::dynamic_fn;

const NAPI_OK: i32 = 0;

type NapiGetUvEventLoop = unsafe extern "C" fn(*mut c_void, *mut *mut uv_loop_t) -> i32;

dynamic_fn!(napi_get_uv_event_loop, NapiGetUvEventLoop);

pub fn get_uv_loop_from_neon(cx: &mut Cx) -> Result<*mut uv_loop_t, String> {
    let func = napi_get_uv_event_loop()?;
    let env = cx.to_raw() as *mut c_void;
    let mut loop_ptr: *mut uv_loop_t = ptr::null_mut();
    let status = unsafe { func(env, &mut loop_ptr) };
    if status != NAPI_OK || loop_ptr.is_null() {
        return Err("napi_get_uv_event_loop failed".to_string());
    }
    Ok(loop_ptr)
}
