use neon::{handle::Handle, prelude::{Context, Cx, ModuleContext}, result::NeonResult, types::{JsBuffer, buffer::TypedArray}};
use x11rb::{connection::Connection, protocol::xproto::{ClientMessageData, ClientMessageEvent, EventMask, intern_atom, query_pointer, send_event}};

mod wayland;

#[neon::export]
fn is_wayland() -> bool {
    wayland::is_wayland()
}

#[neon::export]
fn drag_window<'cx>(cx: &mut Cx<'cx>, handle: Handle<JsBuffer>) -> NeonResult<()> {
    if wayland::is_wayland() {
        wayland::send_xdg_toplevel_move();
    } else {
        let Ok((conn, _)) = x11rb::connect(None) else {
            let err_msg = cx.string("Failed to connect to X11 server");
            return cx.throw(err_msg);
        };

        let buf = handle.as_slice(cx);
        if buf.len() != 4 {
            let err_msg = cx.string("Invalid buffer size for window handle");
            return cx.throw(err_msg);
        }
        let Some(window) = buf.get(0..4).map(|b| u32::from_le_bytes(b.try_into().unwrap())) else {
            let err_msg = cx.string("Failed to parse window handle");
            return cx.throw(err_msg);
        };

        let Ok(query_pointer_reply) = query_pointer(&conn, window).map_err(|_| ()).and_then(|x| x.reply().map_err(|_| ())) else {
            let err_msg = cx.string("Failed to query pointer position");
            return cx.throw(err_msg);
        };

        let Ok(move_atom_reply) = intern_atom(&conn, false, "_NET_WM_MOVERESIZE".as_bytes()).map_err(|_| ()).and_then(|x| x.reply().map_err(|_| ())) else {
            let err_msg = cx.string("Failed to intern atom");
            return cx.throw(err_msg);
        };

        let roots = &conn.setup().roots;
        if roots.is_empty() {
            let err_msg = cx.string("No screens found");
            return cx.throw(err_msg);
        }

        let root_window = roots[0].root;

        let event = ClientMessageEvent::new(32, window, move_atom_reply.atom, ClientMessageData::from([
            query_pointer_reply.root_x as u32,
            query_pointer_reply.root_y as u32,
            8, // _NET_WM_MOVERESIZE_MOVE
            1, // Button 1 (left mouse button)
            0,
        ]));

        if let Err(err) = send_event(&conn, false, root_window, EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY, event) {
            let err_msg = cx.string(format!("Failed to send client message: {}", err));
            return cx.throw(err_msg);
        }

        if let Err(err) = conn.flush() {
            let err_msg = cx.string(format!("Failed to flush X11 connection: {}", err));
            return cx.throw(err_msg);
        }
    }
    Ok(())
}

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    neon::registered().export(&mut cx)?;

    wayland::init_wayland_hook();

    Ok(())
}

#[unsafe(no_mangle)]
pub extern "C" fn on_unload() {
    wayland::remove_wayland_hook();
}

#[used]
#[unsafe(link_section = ".fini_array")]
static DESTRUCTOR: extern "C" fn() = on_unload;
