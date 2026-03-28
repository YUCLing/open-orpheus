use std::sync::Arc;

use egui::text::Galley;
use egui::{Color32, Pos2, Rect};

use super::types::LyricsStyle;

/// Parameters for rendering styled text at a given position.
pub struct StyledTextParams<'a> {
    pub galley: &'a Arc<Galley>,
    pub pos: Pos2,
    pub style: &'a LyricsStyle,
    /// Progress through the line (0.0 = start, 1.0 = fully played).
    pub progress: f32,
    /// Whether this line has been played (affects which color set to use for
    /// the unplayed half when progress = 0 or 1).
    pub is_active: bool,
}

/// Renders a fully styled lyric line: shadow → outline → gradient-split text.
pub fn render_styled_text(painter: &egui::Painter, params: &StyledTextParams) {
    let StyledTextParams {
        galley,
        pos,
        style,
        progress,
        is_active,
    } = params;

    let galley_rect = Rect::from_min_size(*pos, galley.size());

    // 1) Drop shadow (if enabled)
    if style.shadow_enabled {
        render_text_shadow(painter, *pos, galley, style);
    }

    // 2) Outline
    if *is_active {
        let has_played_outline = style.outline_color_played != Color32::TRANSPARENT;
        let has_unplayed_outline = style.outline_color_not_played != Color32::TRANSPARENT;
        if has_played_outline || has_unplayed_outline {
            render_text_outline_split(
                painter,
                *pos,
                galley,
                galley_rect,
                &OutlineSplitParams {
                    played_color: style.outline_color_played,
                    unplayed_color: style.outline_color_not_played,
                    width: style.outline_width,
                    progress: *progress,
                },
            );
        }
    } else {
        let outline_color = style.outline_color_not_played;
        if outline_color != Color32::TRANSPARENT {
            render_text_outline(painter, *pos, galley, outline_color, style.outline_width);
        }
    }

    // 3) Main text with gradient and progress split
    if *is_active {
        render_gradient_text_split(painter, *pos, galley, galley_rect, style, *progress);
    } else {
        // Inactive line: use not-played gradient only
        render_gradient_text(
            painter,
            *pos,
            galley,
            style.not_played_top,
            style.not_played_bottom,
        );
    }
}

/// Renders text with a top-to-bottom color gradient by splitting into thin
/// horizontal strips and lerping the color for each strip's clip region.
fn render_gradient_text(
    painter: &egui::Painter,
    pos: Pos2,
    galley: &Arc<Galley>,
    top_color: Color32,
    bottom_color: Color32,
) {
    if top_color == bottom_color {
        // Uniform color — no need for strips.
        painter.galley_with_override_text_color(pos, galley.clone(), top_color);
        return;
    }

    let galley_rect = Rect::from_min_size(pos, galley.size());
    let clip = painter.clip_rect();
    let steps = gradient_steps(galley_rect.height());

    for i in 0..steps {
        let t0 = i as f32 / steps as f32;
        let t1 = (i + 1) as f32 / steps as f32;
        let color = lerp_color(top_color, bottom_color, (t0 + t1) * 0.5);

        let strip_top = galley_rect.top() + t0 * galley_rect.height();
        let strip_bottom = galley_rect.top() + t1 * galley_rect.height();
        let strip_clip = Rect::from_min_max(
            Pos2::new(clip.left(), strip_top.max(clip.top())),
            Pos2::new(clip.right(), strip_bottom.min(clip.bottom())),
        );
        if !strip_clip.is_positive() {
            continue;
        }

        let strip_painter = painter.with_clip_rect(strip_clip);
        strip_painter.galley_with_override_text_color(pos, galley.clone(), color);
    }
}

/// Renders text with progress split: left portion uses played gradient,
/// right portion uses not-played gradient.
///
/// Uses the painter's existing clip rect (line_clip) for the X bounds of each
/// gradient strip, split horizontally at `split_x`. This ensures the active
/// rendering covers the same X range as the inactive `render_gradient_text`,
/// avoiding edge-clipping artifacts from constraining to galley bounds.
fn render_gradient_text_split(
    painter: &egui::Painter,
    pos: Pos2,
    galley: &Arc<Galley>,
    galley_rect: Rect,
    style: &LyricsStyle,
    progress: f32,
) {
    let split_x = galley_rect.left() + progress * galley_rect.width();
    let clip = painter.clip_rect();
    let steps = gradient_steps(galley_rect.height());

    for i in 0..steps {
        let t0 = i as f32 / steps as f32;
        let t1 = (i + 1) as f32 / steps as f32;

        let strip_top = (galley_rect.top() + t0 * galley_rect.height()).max(clip.top());
        let strip_bottom = (galley_rect.top() + t1 * galley_rect.height()).min(clip.bottom());
        if strip_top >= strip_bottom {
            continue;
        }

        // Played portion (left of split_x)
        if progress > 0.0 {
            let color = lerp_color(style.played_top, style.played_bottom, (t0 + t1) * 0.5);
            let strip_clip = Rect::from_min_max(
                Pos2::new(clip.left(), strip_top),
                Pos2::new(split_x.min(clip.right()), strip_bottom),
            );
            if strip_clip.is_positive() {
                let p = painter.with_clip_rect(strip_clip);
                p.galley_with_override_text_color(pos, galley.clone(), color);
            }
        }

        // Unplayed portion (right of split_x)
        if progress < 1.0 {
            let color = lerp_color(
                style.not_played_top,
                style.not_played_bottom,
                (t0 + t1) * 0.5,
            );
            let strip_clip = Rect::from_min_max(
                Pos2::new(split_x.max(clip.left()), strip_top),
                Pos2::new(clip.right(), strip_bottom),
            );
            if strip_clip.is_positive() {
                let p = painter.with_clip_rect(strip_clip);
                p.galley_with_override_text_color(pos, galley.clone(), color);
            }
        }
    }
}

/// Renders text outline by drawing the same text at 8 directional offsets.
fn render_text_outline(
    painter: &egui::Painter,
    pos: Pos2,
    galley: &Arc<Galley>,
    outline_color: Color32,
    width: f32,
) {
    // 8 directional offsets: N, NE, E, SE, S, SW, W, NW
    for &(dx, dy) in &OUTLINE_OFFSETS {
        let offset_pos = Pos2::new(pos.x + dx * width, pos.y + dy * width);
        painter.galley_with_override_text_color(offset_pos, galley.clone(), outline_color);
    }
}

struct OutlineSplitParams {
    played_color: Color32,
    unplayed_color: Color32,
    width: f32,
    progress: f32,
}

/// Renders text outline with progress split: played outline on left, unplayed on right.
fn render_text_outline_split(
    painter: &egui::Painter,
    pos: Pos2,
    galley: &Arc<Galley>,
    galley_rect: Rect,
    params: &OutlineSplitParams,
) {
    let split_x = galley_rect.left() + params.progress * galley_rect.width();
    // Expand clip slightly to account for outline width
    let expand = params.width + 1.0;

    for &(dx, dy) in &OUTLINE_OFFSETS {
        let offset_pos = Pos2::new(pos.x + dx * params.width, pos.y + dy * params.width);

        if params.progress > 0.0 && params.played_color != Color32::TRANSPARENT {
            let played_clip = Rect::from_min_max(
                Pos2::new(galley_rect.left() - expand, galley_rect.top() - expand),
                Pos2::new(split_x + expand, galley_rect.bottom() + expand),
            )
            .intersect(painter.clip_rect());

            if played_clip.is_positive() {
                let p = painter.with_clip_rect(played_clip);
                p.galley_with_override_text_color(offset_pos, galley.clone(), params.played_color);
            }
        }

        if params.progress < 1.0 && params.unplayed_color != Color32::TRANSPARENT {
            let unplayed_clip = Rect::from_min_max(
                Pos2::new(split_x - expand, galley_rect.top() - expand),
                Pos2::new(galley_rect.right() + expand, galley_rect.bottom() + expand),
            )
            .intersect(painter.clip_rect());

            if unplayed_clip.is_positive() {
                let p = painter.with_clip_rect(unplayed_clip);
                p.galley_with_override_text_color(
                    offset_pos,
                    galley.clone(),
                    params.unplayed_color,
                );
            }
        }
    }
}

/// Renders a multi-layer drop shadow approximating a gaussian blur.
fn render_text_shadow(
    painter: &egui::Painter,
    pos: Pos2,
    galley: &Arc<Galley>,
    style: &LyricsStyle,
) {
    let blur = style.shadow_blur_radius;
    let base_offset = style.shadow_offset;
    let base_color = style.shadow_color;

    // Number of layers scales with blur radius (minimum 3, max 7).
    let layers = ((blur / 2.0).ceil() as usize).clamp(3, 7);

    for i in (0..layers).rev() {
        let t = i as f32 / layers as f32;
        // Spread: outermost layers are further out.
        let spread = blur * (1.0 - t);
        // Opacity: inner layers are more opaque.
        let alpha = (base_color.a() as f32 / layers as f32 * (1.0 + t)) as u8;
        let color = Color32::from_rgba_premultiplied(
            (base_color.r() as u16 * alpha as u16 / 255) as u8,
            (base_color.g() as u16 * alpha as u16 / 255) as u8,
            (base_color.b() as u16 * alpha as u16 / 255) as u8,
            alpha,
        );

        // Render at multiple offsets around the spread circle for this layer.
        let spread_offsets: &[(f32, f32)] = if spread < 0.5 {
            &[(0.0, 0.0)]
        } else {
            &OUTLINE_OFFSETS
        };

        for &(dx, dy) in spread_offsets {
            let shadow_pos = Pos2::new(
                pos.x + base_offset.x + dx * spread,
                pos.y + base_offset.y + dy * spread,
            );
            painter.galley_with_override_text_color(shadow_pos, galley.clone(), color);
        }
    }
}

/// 8 directional unit offsets for outline rendering.
const OUTLINE_OFFSETS: [(f32, f32); 8] = [
    (0.0, -1.0),      // N
    (0.707, -0.707),  // NE
    (1.0, 0.0),       // E
    (0.707, 0.707),   // SE
    (0.0, 1.0),       // S
    (-0.707, 0.707),  // SW
    (-1.0, 0.0),      // W
    (-0.707, -0.707), // NW
];

/// Determines how many horizontal strips to use for gradient rendering.
/// More strips = smoother gradient, but more draw calls.
fn gradient_steps(height: f32) -> usize {
    // One strip per 2 logical pixels, clamped to a reasonable range.
    (height / 2.0).ceil().clamp(2.0, 64.0) as usize
}

/// Linearly interpolates between two colors.
fn lerp_color(a: Color32, b: Color32, t: f32) -> Color32 {
    let t = t.clamp(0.0, 1.0);
    let inv = 1.0 - t;
    Color32::from_rgba_unmultiplied(
        (a.r() as f32 * inv + b.r() as f32 * t) as u8,
        (a.g() as f32 * inv + b.g() as f32 * t) as u8,
        (a.b() as f32 * inv + b.b() as f32 * t) as u8,
        (a.a() as f32 * inv + b.a() as f32 * t) as u8,
    )
}
