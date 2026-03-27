//! Offscreen-rendered window support.
//!
//! An [`OsrWindow`] pairs an Electron offscreen `BrowserWindow` with a native
//! winit/wgpu window.  Electron renders web content to a bitmap (or, in the
//! future, a shared GPU texture via DMA-BUF) and this module composites it
//! onto a real native window — working around Electron's broken transparent
//! window support on Linux Wayland / XWayland.
//!
//! # Data flow
//!
//! ```text
//! Electron BrowserWindow (offscreen)
//!   ─paint─► bitmap / shared texture
//!              │
//!              ▼
//!   OsrWindow::update_frame()
//!              │
//!              ▼
//!   egui managed texture ─► wgpu ─► native winit window
//!
//! Native window input events
//!   ─message handler─► JS callback ─► webContents.sendInputEvent()
//! ```

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};

use egui::{
    ColorImage, TextureId, TextureOptions, ViewportBuilder, ViewportId, load::SizedTexture,
};
use serde::{Deserialize, Serialize};
use winit::{
    dpi::LogicalSize,
    event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent},
    window::{CursorIcon, WindowId},
};

use crate::app::App;

/// Counter for generating unique viewport IDs.
static NEXT_VIEWPORT: AtomicU64 = AtomicU64::new(1);

// ── Options ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsrWindowOptions {
    pub width: f32,
    pub height: f32,
    #[serde(default = "default_true")]
    pub transparent: bool,
    #[serde(default)]
    pub resizable: bool,
    #[serde(default)]
    pub always_on_top: bool,
    #[serde(default)]
    pub skip_taskbar: bool,
    #[serde(default)]
    pub title: Option<String>,
}

fn default_true() -> bool {
    true
}

// ── Input events forwarded to JS ─────────────────────────────────────────────

#[derive(Serialize)]
#[serde(tag = "type")]
pub enum OsrInputEvent {
    #[serde(rename = "mouseMove")]
    MouseMove { x: f64, y: f64 },

    #[serde(rename = "mouseDown")]
    MouseDown {
        x: f64,
        y: f64,
        button: String,
        click_count: u32,
    },

    #[serde(rename = "mouseUp")]
    MouseUp { x: f64, y: f64, button: String },

    #[serde(rename = "mouseWheel")]
    MouseWheel {
        x: f64,
        y: f64,
        delta_x: f64,
        delta_y: f64,
    },

    #[serde(rename = "mouseEnter")]
    MouseEnter { x: f64, y: f64 },

    #[serde(rename = "mouseLeave")]
    MouseLeave,

    #[serde(rename = "resize")]
    Resize {
        width: u32,
        height: u32,
        scale_factor: f64,
    },

    #[serde(rename = "focus")]
    Focus,

    #[serde(rename = "blur")]
    Blur,

    #[serde(rename = "close")]
    Close,
}

// ── Shared rendering state ───────────────────────────────────────────────────

struct OsrState {
    texture_id: Option<TextureId>,
    width: usize,
    height: usize,
    /// RGBA pixel data waiting to be uploaded on the next redraw.
    pending_frame: Option<Vec<u8>>,
}

// ── OsrWindow ────────────────────────────────────────────────────────────────

pub struct OsrWindow {
    app: *const App,
    window_id: WindowId,
    state: Arc<Mutex<OsrState>>,
}

// Safety: The `App` pointer originates from a `Box::into_raw` in the NAPI
// layer and remains valid until `destroy_app` is called.  `OsrState` is
// protected by a `Mutex`.
unsafe impl Send for OsrWindow {}
unsafe impl Sync for OsrWindow {}

impl OsrWindow {
    /// Create a new native window that will display offscreen-rendered content.
    pub async fn new(app: &App, options: OsrWindowOptions) -> Self {
        let seq = NEXT_VIEWPORT.fetch_add(1, Ordering::Relaxed);
        let viewport_id = ViewportId::from_hash_of(format!("osr_{seq}"));

        let mut builder = ViewportBuilder::default()
            .with_inner_size(egui::vec2(options.width, options.height))
            .with_decorations(false)
            .with_resizable(true)
            .with_transparent(options.transparent);

        if options.always_on_top {
            builder = builder.with_always_on_top();
        }
        if let Some(ref title) = options.title {
            builder = builder.with_title(title);
        }

        let state = Arc::new(Mutex::new(OsrState {
            texture_id: None,
            width: options.width as usize,
            height: options.height as usize,
            pending_frame: None,
        }));

        let render_state = state.clone();
        let (_ctx, window_id) = app
            .create_egui_window(viewport_id, builder, move |ctx| {
                let mut st = render_state.lock().unwrap();

                // Upload a new frame when one is pending.
                if let Some(pixels) = st.pending_frame.take() {
                    let image = ColorImage::from_rgba_unmultiplied([st.width, st.height], &pixels);
                    match st.texture_id {
                        Some(id) => {
                            ctx.tex_manager().write().set(
                                id,
                                egui::epaint::ImageDelta::full(image, TextureOptions::LINEAR),
                            );
                        }
                        None => {
                            let id = ctx.tex_manager().write().alloc(
                                format!("osr_frame_{seq}"),
                                image.into(),
                                TextureOptions::LINEAR,
                            );
                            st.texture_id = Some(id);
                        }
                    }
                }

                let tex_id = st.texture_id;
                drop(st);

                egui::CentralPanel::default()
                    .frame(egui::Frame::new().fill(egui::Color32::TRANSPARENT))
                    .show(ctx, |ui| {
                        if let Some(tex_id) = tex_id {
                            let size = ui.available_size();
                            ui.image(SizedTexture::new(tex_id, size));
                        }
                    });
            })
            .await;

        OsrWindow {
            app: app as *const App,
            window_id,
            state,
        }
    }

    /// Push a new frame to the native window.
    ///
    /// `pixels` must be BGRA (Electron `NativeImage.getBitmap()` format).
    /// The buffer is converted to RGBA in-place before upload.
    pub fn update_frame(&self, pixels: &mut [u8], width: usize, height: usize) {
        // BGRA → RGBA (swap B and R channels)
        for chunk in pixels.chunks_exact_mut(4) {
            chunk.swap(0, 2);
        }

        let mut st = self.state.lock().unwrap();

        // Size change → drop old texture ID so it is re-allocated.
        if st.width != width || st.height != height {
            st.texture_id = None;
        }

        st.width = width;
        st.height = height;
        st.pending_frame = Some(pixels.to_vec());
        drop(st);

        let app = unsafe { &*self.app };
        smol::block_on(app.repaint_window(self.window_id));
    }

    /// Attach an input-event handler.
    ///
    /// `callback` is invoked on each mouse / window event with a
    /// JSON-serialised [`OsrInputEvent`].  The callback fires on the winit
    /// event-loop thread; implementations should be non-blocking.
    pub fn set_input_handler(&self, callback: impl Fn(OsrInputEvent) + Send + Sync + 'static) {
        let app = unsafe { &*self.app };
        let mut cursor: (f64, f64) = (0.0, 0.0);

        smol::block_on(app.set_window_message_handler(
            self.window_id,
            move |_window_id, event, window| {
                let scale = window.scale_factor();

                let osr_event = match event {
                    WindowEvent::CursorMoved { position, .. } => {
                        let lp = position.to_logical::<f64>(scale);
                        cursor = (lp.x, lp.y);
                        Some(OsrInputEvent::MouseMove { x: lp.x, y: lp.y })
                    }
                    WindowEvent::MouseInput { state, button, .. } => {
                        let btn = match button {
                            MouseButton::Left => "left",
                            MouseButton::Right => "right",
                            MouseButton::Middle => "middle",
                            _ => return false,
                        };
                        match state {
                            ElementState::Pressed => Some(OsrInputEvent::MouseDown {
                                x: cursor.0,
                                y: cursor.1,
                                button: btn.into(),
                                click_count: 1,
                            }),
                            ElementState::Released => Some(OsrInputEvent::MouseUp {
                                x: cursor.0,
                                y: cursor.1,
                                button: btn.into(),
                            }),
                        }
                    }
                    WindowEvent::MouseWheel { delta, .. } => {
                        let (dx, dy) = match delta {
                            MouseScrollDelta::LineDelta(x, y) => {
                                (*x as f64 * 40.0, *y as f64 * 40.0)
                            }
                            MouseScrollDelta::PixelDelta(pos) => {
                                let lp = pos.to_logical::<f64>(scale);
                                (lp.x, lp.y)
                            }
                        };
                        Some(OsrInputEvent::MouseWheel {
                            x: cursor.0,
                            y: cursor.1,
                            delta_x: dx,
                            delta_y: dy,
                        })
                    }
                    WindowEvent::CursorEntered { .. } => Some(OsrInputEvent::MouseEnter {
                        x: cursor.0,
                        y: cursor.1,
                    }),
                    WindowEvent::CursorLeft { .. } => Some(OsrInputEvent::MouseLeave),
                    WindowEvent::Resized(size) => Some(OsrInputEvent::Resize {
                        width: size.width,
                        height: size.height,
                        scale_factor: scale,
                    }),
                    WindowEvent::Focused(true) => Some(OsrInputEvent::Focus),
                    WindowEvent::Focused(false) => Some(OsrInputEvent::Blur),
                    WindowEvent::CloseRequested => Some(OsrInputEvent::Close),
                    _ => None,
                };

                if let Some(evt) = osr_event {
                    callback(evt);
                    // Consume input events; let rendering events pass through.
                    !matches!(
                        event,
                        WindowEvent::Resized(_)
                            | WindowEvent::Focused(_)
                            | WindowEvent::CloseRequested
                    )
                } else {
                    false
                }
            },
        ));
    }

    /// Set the native window cursor icon from a CSS cursor name
    /// (as emitted by Electron's `cursor-changed` event).
    pub fn set_cursor(&self, cursor_name: &str) {
        let icon = match cursor_name {
            "pointer" => CursorIcon::Default,
            "hand" => CursorIcon::Pointer,
            "text" => CursorIcon::Text,
            "crosshair" => CursorIcon::Crosshair,
            "wait" => CursorIcon::Wait,
            "help" => CursorIcon::Help,
            "move" => CursorIcon::Move,
            "not-allowed" | "no-drop" => CursorIcon::NotAllowed,
            "grab" => CursorIcon::Grab,
            "grabbing" => CursorIcon::Grabbing,
            "col-resize" => CursorIcon::ColResize,
            "row-resize" => CursorIcon::RowResize,
            "n-resize" => CursorIcon::NResize,
            "s-resize" => CursorIcon::SResize,
            "e-resize" => CursorIcon::EResize,
            "w-resize" => CursorIcon::WResize,
            "ne-resize" => CursorIcon::NeResize,
            "nw-resize" => CursorIcon::NwResize,
            "se-resize" => CursorIcon::SeResize,
            "sw-resize" => CursorIcon::SwResize,
            "ns-resize" => CursorIcon::NsResize,
            "ew-resize" => CursorIcon::EwResize,
            "nesw-resize" => CursorIcon::NeswResize,
            "nwse-resize" => CursorIcon::NwseResize,
            "zoom-in" => CursorIcon::ZoomIn,
            "zoom-out" => CursorIcon::ZoomOut,
            "vertical-text" => CursorIcon::VerticalText,
            "cell" => CursorIcon::Cell,
            "context-menu" => CursorIcon::ContextMenu,
            "alias" => CursorIcon::Alias,
            "progress" => CursorIcon::Progress,
            "all-scroll" => CursorIcon::AllScroll,
            "copy" => CursorIcon::Copy,
            "none" => CursorIcon::Default, // winit doesn't have a "none" — handled by hiding
            _ => CursorIcon::Default,
        };
        let app = unsafe { &*self.app };
        app.set_cursor(self.window_id, icon);
    }

    /// Begin an interactive drag of the native window.
    ///
    /// Call this from a `mouseDown` handler when the cursor is inside a
    /// drag region (e.g. a title bar rendered by the web content).
    pub fn drag(&self) {
        let app = unsafe { &*self.app };
        app.drag_window(self.window_id);
    }

    /// Resize the native window.
    pub fn resize(&self, width: f64, height: f64) {
        let app = unsafe { &*self.app };
        smol::block_on(app.set_window_inner_size(self.window_id, LogicalSize::new(width, height)));
    }

    /// Close and destroy the native window.
    pub fn close(&self) {
        let app = unsafe { &*self.app };
        smol::block_on(app.close_window(self.window_id));
    }
}
