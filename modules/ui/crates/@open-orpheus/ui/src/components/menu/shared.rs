use egui::Color32;

/// Submenu auto-close delay: if the cursor leaves the deepest submenu and its
/// trigger item for this long, the submenu is closed.
pub const SUBMENU_IDLE_MS: u128 = 400;

/// Poll interval for the coordinator loop (≈60 fps).
pub const POLL_INTERVAL_MS: u64 = 16;

/// Hover highlight colour for menu items.
pub const HOVER_FILL: Color32 = Color32::from_rgb(225, 235, 252);

/// Pressed highlight colour for menu items.
pub const PRESS_FILL: Color32 = Color32::from_rgb(198, 216, 249);

/// Returns a `ViewportBuilder` preconfigured for a menu popup window.
///
/// The builder has: no decorations, no taskbar entry, always-on-top,
/// non-resizable, and transparency enabled.
pub fn menu_viewport_builder() -> egui::ViewportBuilder {
    egui::ViewportBuilder::default()
        .with_always_on_top()
        .with_window_level(egui::WindowLevel::AlwaysOnTop)
        .with_decorations(false)
        .with_taskbar(false)
        .with_resizable(false)
        .with_transparent(true)
}
