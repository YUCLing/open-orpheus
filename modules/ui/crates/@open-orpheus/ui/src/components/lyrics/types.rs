use egui::{Align, Color32, FontFamily, FontId};
use serde::Deserialize;

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
        }
    }
}

impl LyricsStyle {
    /// Returns the `FontId` for the primary lyrics text.
    pub fn font_id(&self) -> FontId {
        let family = if self.font_family.is_empty() {
            FontFamily::Proportional
        } else {
            FontFamily::Name(self.font_family.clone().into())
        };
        FontId::new(self.font_size, family)
    }

    /// Returns the `FontId` for secondary (translation) lyrics text.
    pub fn secondary_font_id(&self) -> FontId {
        let family = if self.font_family.is_empty() {
            FontFamily::Proportional
        } else {
            FontFamily::Name(self.font_family.clone().into())
        };
        FontId::new(self.font_size * self.secondary_font_scale, family)
    }
}
