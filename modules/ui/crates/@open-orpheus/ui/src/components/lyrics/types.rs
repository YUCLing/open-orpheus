use egui::{Align, Color32, FontFamily, FontId};
use serde::Deserialize;

/// JSON-friendly style DTO for setting lyrics style from JavaScript.
/// Colors are `[r, g, b]` arrays. Alignment is `"left"`, `"center"`, or `"right"`.
#[derive(Clone, Debug, Deserialize)]
pub struct LyricsStyleDto {
    #[serde(default)]
    pub not_played_top: Option<[u8; 3]>,
    #[serde(default)]
    pub not_played_bottom: Option<[u8; 3]>,
    #[serde(default)]
    pub played_top: Option<[u8; 3]>,
    #[serde(default)]
    pub played_bottom: Option<[u8; 3]>,
    #[serde(default)]
    pub outline_color_not_played: Option<[u8; 3]>,
    #[serde(default)]
    pub outline_color_played: Option<[u8; 3]>,
    #[serde(default)]
    pub outline_width: Option<f32>,
    #[serde(default)]
    pub shadow_enabled: Option<bool>,
    #[serde(default)]
    pub shadow_blur_radius: Option<f32>,
    #[serde(default)]
    pub shadow_offset: Option<[f32; 2]>,
    #[serde(default)]
    pub shadow_color: Option<[u8; 4]>,
    #[serde(default)]
    pub font_family: Option<String>,
    #[serde(default)]
    pub font_size: Option<f32>,
    #[serde(default)]
    pub bold: Option<bool>,
    #[serde(default)]
    pub text_align: Option<[String; 2]>,
    #[serde(default)]
    pub line_mode: Option<String>,
    #[serde(default)]
    pub show_horizontal: Option<bool>,
    #[serde(default)]
    pub offset_ms: Option<f64>,
    #[serde(default)]
    pub secondary_font_scale: Option<f32>,
}

impl LyricsStyleDto {
    /// Apply this DTO's non-None fields onto an existing style.
    pub fn apply_to(&self, style: &mut LyricsStyle) {
        if let Some(c) = self.not_played_top {
            style.not_played_top = Color32::from_rgb(c[0], c[1], c[2]);
        }
        if let Some(c) = self.not_played_bottom {
            style.not_played_bottom = Color32::from_rgb(c[0], c[1], c[2]);
        }
        if let Some(c) = self.played_top {
            style.played_top = Color32::from_rgb(c[0], c[1], c[2]);
        }
        if let Some(c) = self.played_bottom {
            style.played_bottom = Color32::from_rgb(c[0], c[1], c[2]);
        }
        if let Some(c) = self.outline_color_not_played {
            style.outline_color_not_played = Color32::from_rgb(c[0], c[1], c[2]);
        }
        if let Some(c) = self.outline_color_played {
            style.outline_color_played = Color32::from_rgb(c[0], c[1], c[2]);
        }
        if let Some(w) = self.outline_width {
            style.outline_width = w;
        }
        if let Some(e) = self.shadow_enabled {
            style.shadow_enabled = e;
        }
        if let Some(r) = self.shadow_blur_radius {
            style.shadow_blur_radius = r;
        }
        if let Some(o) = self.shadow_offset {
            style.shadow_offset = egui::Vec2::new(o[0], o[1]);
        }
        if let Some(c) = self.shadow_color {
            style.shadow_color = Color32::from_rgba_unmultiplied(c[0], c[1], c[2], c[3]);
        }
        if let Some(ref f) = self.font_family {
            if style.font_family != *f {
                style.font_family = f.clone();
                style.font_loaded = false;
            }
        }
        if let Some(s) = self.font_size {
            style.font_size = s;
        }
        if let Some(b) = self.bold {
            style.bold = b;
        }
        if let Some(ref a) = self.text_align {
            style.text_align = [parse_align(&a[0]), parse_align(&a[1])];
        }
        if let Some(ref m) = self.line_mode {
            style.line_mode = match m.as_str() {
                "single" => LineMode::Single,
                _ => LineMode::Double,
            };
        }
        if let Some(h) = self.show_horizontal {
            style.show_horizontal = h;
        }
        if let Some(o) = self.offset_ms {
            style.offset_ms = o;
        }
        if let Some(s) = self.secondary_font_scale {
            style.secondary_font_scale = s;
        }
    }
}

fn parse_align(s: &str) -> Align {
    match s {
        "left" => Align::Min,
        "right" => Align::Max,
        _ => Align::Center,
    }
}

/// Top-level container for lyrics data, including optional secondary lyrics
/// (translations, romanization, etc.).
#[derive(Clone, Debug, Deserialize)]
pub struct LyricsData {
    /// Primary lyrics timeline.
    pub lines: Vec<LyricLine>,
    /// Optional secondary lyrics (translation/romanization) with its own timeline.
    pub secondary_lines: Option<Vec<LyricLine>>,
}

/// A single line of lyrics with timing information and per-word segments.
#[derive(Clone, Debug, Deserialize)]
pub struct LyricLine {
    /// Line start time in milliseconds.
    pub start_time: f64,
    /// Line end time in milliseconds.
    pub end_time: f64,
    /// Per-word segments. For plain LRC, this is a single word containing the
    /// entire line text. For YRC/KRC, each word has its own timing.
    pub words: Vec<LyricWord>,
}

impl LyricLine {
    /// Returns the full text of this line by concatenating all words.
    pub fn text(&self) -> String {
        self.words.iter().map(|w| w.text.as_str()).collect()
    }

    /// Duration of this line in milliseconds.
    pub fn duration(&self) -> f64 {
        self.end_time - self.start_time
    }
}

/// A single word or syllable within a lyric line, with per-word timing for
/// karaoke-style rendering.
#[derive(Clone, Debug, Deserialize)]
pub struct LyricWord {
    /// The text content of this word/syllable.
    pub text: String,
    /// Start time offset within the line, in milliseconds.
    pub start_time: f64,
    /// Duration of this word in milliseconds.
    pub duration: f64,
}

/// Display mode: single line or double line.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Default)]
pub enum LineMode {
    Single,
    #[default]
    Double,
}

/// Visual style for lyrics rendering.
#[derive(Clone, Debug)]
pub struct LyricsStyle {
    // Gradient colors for unplayed text (top to bottom).
    pub not_played_top: Color32,
    pub not_played_bottom: Color32,
    // Gradient colors for played text (top to bottom).
    pub played_top: Color32,
    pub played_bottom: Color32,
    // Outline colors.
    pub outline_color_not_played: Color32,
    pub outline_color_played: Color32,
    /// Outline width in logical pixels.
    pub outline_width: f32,
    /// Shadow enable flags (matches NCM's 4-bool pattern).
    pub shadow_enabled: bool,
    /// Shadow blur radius in logical pixels.
    pub shadow_blur_radius: f32,
    /// Shadow offset.
    pub shadow_offset: egui::Vec2,
    /// Shadow color.
    pub shadow_color: Color32,
    /// Font family name (empty string = default proportional).
    pub font_family: String,
    /// Font size in points.
    pub font_size: f32,
    /// Whether text is bold.
    pub bold: bool,
    /// Per-line text alignment: [upper_line, lower_line].
    pub text_align: [Align; 2],
    /// Single or double line mode.
    pub line_mode: LineMode,
    /// If true, display horizontally; if false, display vertically.
    pub show_horizontal: bool,
    /// Global timing offset in milliseconds.
    pub offset_ms: f64,
    /// Secondary line font size multiplier (relative to primary).
    pub secondary_font_scale: f32,
    /// Whether the custom font family has been successfully loaded into egui.
    pub font_loaded: bool,
}

impl Default for LyricsStyle {
    fn default() -> Self {
        Self {
            not_played_top: Color32::from_rgb(255, 255, 255),
            not_played_bottom: Color32::from_rgb(200, 200, 200),
            played_top: Color32::from_rgb(0, 200, 255),
            played_bottom: Color32::from_rgb(0, 150, 220),
            outline_color_not_played: Color32::TRANSPARENT,
            outline_color_played: Color32::TRANSPARENT,
            outline_width: 1.0,
            shadow_enabled: false,
            shadow_blur_radius: 4.0,
            shadow_offset: egui::Vec2::new(1.0, 1.0),
            shadow_color: Color32::from_black_alpha(128),
            font_family: String::new(),
            font_size: 24.0,
            bold: false,
            text_align: [Align::Center, Align::Center],
            line_mode: LineMode::Double,
            show_horizontal: true,
            offset_ms: 0.0,
            secondary_font_scale: 0.75,
            font_loaded: false,
        }
    }
}

impl LyricsStyle {
    /// Attempt to load the custom font family into egui if not already loaded.
    /// Must be called with access to the egui context before layout/rendering.
    pub fn ensure_font_loaded(&mut self, ctx: &egui::Context) {
        if self.font_family.is_empty() || self.font_loaded {
            return;
        }
        self.font_loaded = crate::app::fonts::load_custom_font(ctx, &self.font_family);
    }

    /// Returns the `FontId` for the primary lyrics text.
    pub fn font_id(&self) -> FontId {
        let family = if self.font_family.is_empty() || !self.font_loaded {
            FontFamily::Proportional
        } else {
            FontFamily::Name(self.font_family.clone().into())
        };
        FontId::new(self.font_size, family)
    }

    /// Returns the `FontId` for secondary (translation) lyrics text.
    pub fn secondary_font_id(&self) -> FontId {
        let family = if self.font_family.is_empty() || !self.font_loaded {
            FontFamily::Proportional
        } else {
            FontFamily::Name(self.font_family.clone().into())
        };
        FontId::new(self.font_size * self.secondary_font_scale, family)
    }
}
