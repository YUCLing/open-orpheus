use egui::{Pos2, Rect, Response, Sense, Ui, Vec2, Widget};

use super::{
    layout::{layout_horizontal, layout_vertical},
    state::LyricsState,
    text_effects::{StyledTextParams, render_styled_text},
};

/// An embeddable egui widget that renders karaoke-style lyrics with gradient
/// text, outlines, drop shadows, per-word progress, and overflow scrolling.
///
/// # Usage
/// ```ignore
/// let mut state = LyricsState::new();
/// state.set_data(Some(lyrics_data));
/// state.set_time(current_time_ms);
///
/// ui.add(LyricsWidget::new(&state));
/// ```
pub struct LyricsWidget<'a> {
    state: &'a LyricsState,
}

impl<'a> LyricsWidget<'a> {
    pub fn new(state: &'a LyricsState) -> Self {
        Self { state }
    }
}

impl Widget for LyricsWidget<'_> {
    fn ui(self, ui: &mut Ui) -> Response {
        let available = ui.available_size();
        let (rect, response) = ui.allocate_exact_size(available, Sense::hover());

        if !ui.is_rect_visible(rect) {
            return response;
        }

        let data = match &self.state.data {
            Some(data) if !data.lines.is_empty() => data,
            _ => return response,
        };

        let style = &self.state.style;
        let effective_time = self.state.effective_time();

        // Perform layout.
        let layout = if style.show_horizontal {
            layout_horizontal(ui, data, style, effective_time, available)
        } else {
            layout_vertical(ui, data, style, effective_time, available)
        };

        // Create a painter clipped to the widget's allocated rect.
        let painter = ui.painter_at(rect);

        for line in &layout.visible_lines {
            // Apply the widget's origin offset.
            let render_pos = Pos2::new(rect.left() + line.pos.x, rect.top() + line.pos.y);

            // For horizontal mode, clip to the widget rect to hide overflowed text.
            // For vertical mode, the overflow is vertical so we clip accordingly.
            let line_clip = if style.show_horizontal {
                let galley_height = line.galley.size().y;
                Rect::from_min_size(
                    Pos2::new(rect.left(), render_pos.y),
                    Vec2::new(rect.width(), galley_height),
                )
                .intersect(rect)
            } else {
                let galley_width = line.galley.size().x;
                Rect::from_min_size(
                    Pos2::new(render_pos.x, rect.top()),
                    Vec2::new(galley_width, rect.height()),
                )
                .intersect(rect)
            };

            if !line_clip.is_positive() {
                continue;
            }

            let clipped_painter = painter.with_clip_rect(line_clip);

            render_styled_text(
                &clipped_painter,
                &StyledTextParams {
                    galley: &line.galley,
                    pos: render_pos,
                    style,
                    progress: line.progress,
                    is_active: line.is_active,
                },
            );
        }

        response
    }
}
