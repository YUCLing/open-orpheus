use crate::menu::Menu;

mod menu;

// Use #[neon::export] to export Rust functions as JavaScript functions.
// See more at: https://docs.rs/neon/latest/neon/attr.export.html

#[neon::export]
fn create_menu() -> f64 {
    let menu = Menu::new();

    let ptr = Box::into_raw(Box::new(menu));

    ptr as usize as f64
}

// Use #[neon::main] to add additional behavior at module loading time.
// See more at: https://docs.rs/neon/latest/neon/attr.main.html

// #[neon::main]
// fn main(_cx: ModuleContext) -> NeonResult<()> {
//     println!("module is loaded!");
//     Ok(())
// }
