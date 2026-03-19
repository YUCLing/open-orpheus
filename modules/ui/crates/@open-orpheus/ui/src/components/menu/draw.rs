use std::sync::Arc;

use egui::{Color32, Margin, Pos2, Sense, Vec2};
use winit::dpi::{PhysicalPosition, PhysicalSize};

use crate::{
    app::App,
    skin::{ElementTemplate, LayoutNode, MenuSkin, parse_btn_url, parse_element_template},
};

use super::types::{MenuItem, MenuItemBtn, MenuItemPatch};

/// Load [`ElementTemplate`]s for every distinct `style` referenced by `items`,
/// recursively including any children. Returns a map keyed by style name.
pub async fn load_templates(
    app: &App,
    items: &[MenuItem],
) -> Arc<std::collections::HashMap<String, ElementTemplate>> {
    let mut map = std::collections::HashMap::new();
    let mut stack: Vec<&[MenuItem]> = vec![items];
    while let Some(level) = stack.pop() {
        for item in level {
            if let Some(style) = &item.style {
                if !map.contains_key(style.as_str()) {
                    let xml = app
                        .resource_handler()
                        .read_skin_pack(&format!("/{}", style))
                        .await;
                    map.insert(style.clone(), parse_element_template(&xml));
                }
            }
            if let Some(children) = &item.children {
                stack.push(children);
            }
        }
    }
    Arc::new(map)
}

/// Compute the final logical position for a popup window of `size`, trying to
/// stay inside the monitor that contains `desired_pos`.
///
/// `monitors` is a list of `(physical_pos, physical_size)` tuples. If empty the
/// function just returns `desired_pos` unchanged.
pub fn clamp_to_screen(
    desired: Pos2,
    size: Vec2,
    monitors: &[(PhysicalPosition<i32>, PhysicalSize<u32>)],
) -> Pos2 {
    // Find the monitor whose rect contains `desired`, or fall back to the first.
    let monitor = monitors
        .iter()
        .find(|(pos, sz)| {
            desired.x >= pos.x as f32
                && desired.y >= pos.y as f32
                && desired.x < (pos.x as f32 + sz.width as f32)
                && desired.y < (pos.y as f32 + sz.height as f32)
        })
        .or_else(|| monitors.first());

    let Some((mon_pos, mon_size)) = monitor else {
        return desired;
    };

    let mon_x = mon_pos.x as f32;
    let mon_y = mon_pos.y as f32;
    let mon_w = mon_size.width as f32;
    let mon_h = mon_size.height as f32;

    let x = desired.x.min(mon_x + mon_w - size.x).max(mon_x);
    let y = desired.y.min(mon_y + mon_h - size.y).max(mon_y);
    Pos2::new(x, y)
}

/// Renders all menu items into `ui`.
///
/// For each non-separator item, `on_item(index, &response)` is called after
/// layout. The callback may return a `Color32` to override the frame fill
/// (for hover/press highlights), or `None` to leave it transparent.
/// For a pure measurement pass, pass `|_, _| None`.
///
/// `on_click(id)` is fired when a leaf menu item (no children) is clicked —
/// with `item.menu_id` for text rows or `btn.id` for icon buttons.
pub fn draw_menu_items(
    ui: &mut egui::Ui,
    items: &[MenuItem],
    skin: &MenuSkin,
    templates: &std::collections::HashMap<String, ElementTemplate>,
    overrides: &std::collections::HashMap<String, MenuItemPatch>,
    mut on_item: impl FnMut(usize, &MenuItem, &egui::Response) -> Option<Color32>,
    on_click: &mut dyn FnMut(String, bool),
) {
    let [top_pad, left_pad, bottom_pad, right_pad] = skin.inset;
    let text_color = Color32::from_rgb(30, 30, 30);
    let disabled_color = Color32::from_rgb(160, 160, 160);
    let h_margin = Margin {
        left: left_pad as i8,
        right: right_pad as i8,
        top: 8,
        bottom: 8,
    };

    ui.add_space(top_pad);
    for (idx, item) in items.iter().enumerate() {
        if item.separator {
            egui::Frame::new()
                .inner_margin(Margin {
                    top: 4,
                    bottom: 4,
                    ..h_margin
                })
                .show(ui, |ui| {
                    ui.separator();
                });
            continue;
        }

        let effective_item_owned;
        let effective_item: &MenuItem = match item
            .menu_id
            .as_ref()
            .and_then(|id| overrides.get(id.as_str()))
        {
            Some(patch) => {
                effective_item_owned = patch.apply_to(item);
                &effective_item_owned
            }
            None => item,
        };

        // Style template row (e.g. playback controls with icon buttons).
        if let Some(tpl) = effective_item
            .style
            .as_ref()
            .and_then(|s| templates.get(s.as_str()))
        {
            if let Some(btns) = &effective_item.btns {
                let mut frame = egui::Frame::new().begin(ui);
                frame
                    .content_ui
                    .set_width(ui.available_width() - left_pad - right_pad);
                frame.content_ui.set_min_height(tpl.height);
                let mut btn_idx = 0usize;
                render_layout_node(
                    &mut frame.content_ui,
                    &tpl.layout,
                    btns,
                    &mut btn_idx,
                    text_color,
                    &mut |id| on_click(id, false),
                );
                frame.end(ui);
                continue;
            }
        }

        // Normal text item.
        let mut frame = egui::Frame::new().inner_margin(h_margin).begin(ui);
        frame
            .content_ui
            .set_width(ui.available_width() - left_pad - right_pad);
        let color = if effective_item.enable {
            text_color
        } else {
            disabled_color
        };
        frame.content_ui.horizontal(|ui| {
            if let Some(image) = &effective_item.image_path {
                ui.add(egui::Image::new(image).tint(color));
            }
            ui.add(egui::Label::new(
                egui::RichText::new(&effective_item.text).color(color),
            ));
            let right_icon = effective_item
                .check_image_path
                .as_deref()
                .map(|s| s.to_owned())
                .or_else(|| {
                    effective_item
                        .children
                        .is_some()
                        .then(|| "native://skin/menu/sub_icon.svg".to_owned())
                });
            if let Some(icon) = right_icon {
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.add(egui::Image::new(icon.as_str()).tint(color));
                });
            }
        });
        let rect = frame.frame.outer_rect(frame.content_ui.min_rect());
        let response = ui.allocate_rect(rect, Sense::click());
        if let Some(fill) = on_item(idx, effective_item, &response) {
            frame.frame.fill = fill;
        }
        if response.clicked() && effective_item.enable && effective_item.children.is_none() {
            if let Some(id) = &effective_item.menu_id {
                on_click(id.clone(), true);
            }
        }
        frame.paint(ui);
    }
    ui.add_space(bottom_pad);
}

/// Recursively render a [`LayoutNode`] tree into egui.
///
/// `btn_idx` is advanced by one for each `Button` node encountered, mapping
/// tree-order `<Button>` elements to the `btns` slice by index regardless of
/// how the XML is structured around them.
pub fn render_layout_node(
    ui: &mut egui::Ui,
    node: &LayoutNode,
    btns: &[MenuItemBtn],
    btn_idx: &mut usize,
    text_color: Color32,
    on_btn_click: &mut dyn FnMut(String),
) {
    match node {
        LayoutNode::Horizontal(children) => {
            ui.horizontal(|ui| {
                for child in children {
                    render_layout_node(ui, child, btns, btn_idx, text_color, on_btn_click);
                }
            });
        }
        LayoutNode::Vertical(children) => {
            ui.vertical(|ui| {
                for child in children {
                    render_layout_node(ui, child, btns, btn_idx, text_color, on_btn_click);
                }
            });
        }
        LayoutNode::Container {
            width,
            height,
            children,
        } => {
            if children.is_empty() {
                // No children — act as a sized spacer in the current direction.
                let space = width.or(*height).unwrap_or(0.0);
                ui.add_space(space);
            } else {
                egui::Frame::new().show(ui, |ui| {
                    if let Some(w) = width {
                        ui.set_width(*w);
                    }
                    if let Some(h) = height {
                        ui.set_height(*h);
                    }
                    for child in children {
                        render_layout_node(ui, child, btns, btn_idx, text_color, on_btn_click);
                    }
                });
            }
        }
        // Fixed spacer: width takes priority (horizontal context); height used in vertical.
        LayoutNode::Control { width: Some(w), .. } => {
            ui.add_space(*w);
        }
        LayoutNode::Control {
            height: Some(h), ..
        } => {
            ui.add_space(*h);
        }
        // Fill: consume remaining space in the current layout direction.
        LayoutNode::Control { .. } => {
            let rem = ui.available_width().max(ui.available_height());
            if rem > 0.0 {
                ui.add_space(rem);
            }
        }
        LayoutNode::Button { width, height } => {
            if let Some(btn) = btns.get(*btn_idx) {
                if let Some(images) = parse_btn_url(&btn.url) {
                    let btn_size = Vec2::new(*width, *height);
                    let (_id, btn_rect) = ui.allocate_space(btn_size);
                    let hover_pos = ui.input(|i| i.pointer.hover_pos());
                    let hovered = hover_pos.is_some_and(|p| btn_rect.contains(p));
                    let pressed = hovered && ui.input(|i| i.pointer.any_down());
                    let hot_or_normal = images.hot.as_ref().unwrap_or(&images.normal);
                    let state = if !btn.enable {
                        images.disabled.as_ref().unwrap_or(&images.normal)
                    } else if pressed {
                        images.pushed.as_ref().unwrap_or(hot_or_normal)
                    } else if hovered {
                        hot_or_normal
                    } else {
                        &images.normal
                    };
                    let btn_response = ui.put(
                        btn_rect,
                        egui::Image::new(state.uri.as_str())
                            .fit_to_exact_size(btn_size)
                            .tint(state.color.unwrap_or(text_color))
                            .sense(egui::Sense::click()),
                    );
                    if btn_response.clicked() && btn.enable {
                        on_btn_click(btn.id.clone());
                    }
                }
            }
            *btn_idx += 1;
        }
    }
}

/// Measures the natural size of the menu content using a dry-run egui layout pass.
/// This avoids relying on post-creation window resizing, which is unreliable on Wayland.
pub fn measure_items(
    items: &[MenuItem],
    skin: &MenuSkin,
    templates: Arc<std::collections::HashMap<String, ElementTemplate>>,
) -> Vec2 {
    // SAFETY: the closure is consumed synchronously inside `measure_ui`'s
    // `ctx.run(...)` call before `measure_items` returns, so the borrow of
    // `items` is valid for its entire use.
    let items_ref: &'static [MenuItem] = unsafe { &*(items as *const [MenuItem]) };
    let skin = skin.clone();
    crate::util::measure_ui(App::create_context(), skin.max_width, move |ui| {
        ui.style_mut().spacing.item_spacing.y = 0.0;
        draw_menu_items(
            ui,
            items_ref,
            &skin,
            &templates,
            &std::collections::HashMap::new(),
            |_, _, _| None,
            &mut |_, _| {},
        );
    })
}
