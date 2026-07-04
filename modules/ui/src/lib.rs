#![deny(clippy::all)]

use font_kit::source::SystemSource;
use napi::{
    bindgen_prelude::{Array, AsyncTask},
    Env, Error, Result, ScopedTask,
};
use napi_derive::napi;

/// Get all font families available on the system.
#[napi(ts_return_type = "string[]")]
pub fn get_system_fonts<'env>(env: &'env Env) -> Result<Array<'env>> {
    let src = SystemSource::new();

    let families = src
        .all_families()
        .map_err(|err| Error::from_reason(err.to_string()))?;

    let mut arr = env.create_array(families.len() as u32)?;

    for (i, family) in families.into_iter().enumerate() {
        arr.set(i as u32, family)?;
    }

    Ok(arr)
}

pub struct AsyncCJKFontTask;

#[napi]
impl<'env> ScopedTask<'env> for AsyncCJKFontTask {
    type Output = Vec<String>;

    type JsValue = Array<'env>;

    fn compute(&mut self) -> Result<Self::Output> {
        let src = SystemSource::new();

        let fonts = src
            .all_fonts()
            .map_err(|err| Error::from_reason(err.to_string()))?;

        Ok(fonts
            .iter()
            .filter_map(|x| x.load().ok())
            .filter(|x| x.glyph_for_char('中').is_some())
            .map(|x| x.family_name())
            .collect())
    }

    fn resolve(&mut self, env: &'env Env, output: Self::Output) -> Result<Self::JsValue> {
        let mut arr = env.create_array(output.len() as u32)?;

        for (i, family) in output.into_iter().enumerate() {
            arr.set(i as u32, family)?;
        }

        Ok(arr)
    }
}

/// Get all fonts that can render CJK characters, note that this will attempt to load all fonts
/// to determine whether it matches the requirements or not.
#[napi(ts_return_type = "Promise<string[]>")]
pub fn get_cjk_fonts() -> AsyncTask<AsyncCJKFontTask> {
    AsyncTask::new(AsyncCJKFontTask {})
}
