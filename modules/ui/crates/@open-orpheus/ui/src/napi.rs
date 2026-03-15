use libuv_sys2::uv_loop_t;
use neon::prelude::*;
use std::{ffi::c_void, ptr};

// N-API types
const NAPI_OK: i32 = 0;

unsafe extern "C" {
  // From Node-API / N-API:
  // napi_status napi_get_uv_event_loop(napi_env env, struct uv_loop_s** loop);
  pub fn napi_get_uv_event_loop(env: *mut c_void, loop_out: *mut *mut uv_loop_t) -> i32;
}

pub fn get_uv_loop_from_neon(cx: &mut Cx) -> Result<*mut uv_loop_t, String> {
  let env = cx.to_raw() as *mut c_void;
  let mut loop_ptr: *mut uv_loop_t = ptr::null_mut();
  let status = unsafe { napi_get_uv_event_loop(env, &mut loop_ptr) };
  if status != NAPI_OK || loop_ptr.is_null() {
    return Err("napi_get_uv_event_loop failed".to_string());
  }
  Ok(loop_ptr)
}
