use neon::{prelude::ModuleContext, result::NeonResult};

mod wayland;

// TODO: X11 support

#[neon::export]
fn drag_window() {
    if wayland::is_wayland() {
        wayland::send_xdg_toplevel_move();
    } else {
        eprintln!("Not running under Wayland, drag_window is not supported currently.");
    }
}

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    neon::registered().export(&mut cx)?;

    wayland::init_wayland_hook();

    Ok(())
}
