mod app;
mod components;
pub mod dynload;
mod export;
mod napi;
pub mod osr;
mod resource;
mod skin;
mod util;

// Use #[neon::export] to export Rust functions as JavaScript functions.
// See more at: https://docs.rs/neon/latest/neon/attr.export.html

// Use #[neon::main] to add additional behavior at module loading time.
// See more at: https://docs.rs/neon/latest/neon/attr.main.html

// #[neon::main]
// fn main(_cx: ModuleContext) -> NeonResult<()> {
//     println!("module is loaded!");
//     Ok(())
// }
