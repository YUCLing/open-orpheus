use std::ffi::{CStr, c_void};
use std::ptr;

#[cfg(unix)]
use std::ffi::c_char;

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

fn resolve_ptr(name: &CStr) -> Result<*mut c_void, String> {
    #[cfg(unix)]
    unsafe {
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

        let sym = dlsym(handle, name.as_ptr());
        if sym.is_null() {
            let err = dlerror();
            let msg = if err.is_null() {
                "symbol not found".to_string()
            } else {
                CStr::from_ptr(err).to_string_lossy().into_owned()
            };
            return Err(format!(
                "failed to resolve {}: {msg}",
                name.to_string_lossy()
            ));
        }

        return Ok(sym);
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

        let sym = GetProcAddress(module, name.as_ptr() as *const u8);
        if sym.is_null() {
            return Err(format!(
                "failed to resolve {}: {}",
                name.to_string_lossy(),
                GetLastError()
            ));
        }

        return Ok(sym);
    }

    #[allow(unreachable_code)]
    Err("unsupported platform for dynamic symbol resolution".to_string())
}

/// Resolve a named symbol from the current process's symbol table and
/// transmute it into `F`.
///
/// # Safety
/// The caller must ensure `F` is a function pointer type whose signature
/// matches the actual exported C symbol.
pub unsafe fn resolve_symbol<F: Copy>(name: &CStr) -> Result<F, String> {
    let ptr = resolve_ptr(name)?;
    Ok(std::mem::transmute_copy::<*mut c_void, F>(&ptr))
}

/// Declare a lazily-resolved, cached dynamic C-symbol accessor.
///
/// # Usage
///
/// ```rust
/// type MyFnType = unsafe extern "C" fn(/* args */) -> /* ret */;
///
/// // Accessor name matches the C symbol name:
/// dynamic_fn!(my_c_symbol, MyFnType);
///
/// // Or provide an explicit symbol name:
/// dynamic_fn!(my_accessor, MyFnType, "my_c_symbol");
/// ```
///
/// Each form expands to a private `fn` that resolves the symbol on first call
/// and caches the result in a `OnceLock`.
#[macro_export]
macro_rules! dynamic_fn {
    // Accessor name doubles as the C symbol name.
    ($name:ident, $fn_type:ty) => {
        fn $name() -> Result<$fn_type, String> {
            static RESOLVED: ::std::sync::OnceLock<Result<$fn_type, String>> =
                ::std::sync::OnceLock::new();
            RESOLVED
                .get_or_init(|| unsafe {
                    $crate::dynload::resolve_symbol::<$fn_type>(
                        ::std::ffi::CStr::from_bytes_with_nul(
                            ::std::concat!(::std::stringify!($name), "\0").as_bytes(),
                        )
                        .unwrap(),
                    )
                })
                .clone()
        }
    };
    // Explicit C symbol name supplied as a string literal.
    ($name:ident, $fn_type:ty, $symbol:literal) => {
        fn $name() -> Result<$fn_type, String> {
            static RESOLVED: ::std::sync::OnceLock<Result<$fn_type, String>> =
                ::std::sync::OnceLock::new();
            RESOLVED
                .get_or_init(|| unsafe {
                    $crate::dynload::resolve_symbol::<$fn_type>(
                        ::std::ffi::CStr::from_bytes_with_nul(
                            ::std::concat!($symbol, "\0").as_bytes(),
                        )
                        .unwrap(),
                    )
                })
                .clone()
        }
    };
}
