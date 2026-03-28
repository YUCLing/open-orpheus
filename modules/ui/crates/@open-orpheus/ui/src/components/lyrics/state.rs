use super::types::{LyricsData, LyricsStyle};

/// Mutable state for the lyrics widget, updated externally by the host.
pub struct LyricsState {
    /// Current playback time in milliseconds.
    pub current_time: f64,
    /// The parsed lyrics data (primary + optional secondary).
    pub data: Option<LyricsData>,
    /// Visual styling configuration.
    pub style: LyricsStyle,
}

impl Default for LyricsState {
    fn default() -> Self {
        Self {
            current_time: 0.0,
            data: None,
            style: LyricsStyle::default(),
        }
    }
}

impl LyricsState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Update the current playback time (in milliseconds).
    pub fn set_time(&mut self, time_ms: f64) {
        self.current_time = time_ms;
    }

    /// Set the lyrics data. Pass `None` to clear.
    pub fn set_data(&mut self, data: Option<LyricsData>) {
        self.data = data;
    }

    /// Replace the visual style.
    pub fn set_style(&mut self, style: LyricsStyle) {
        self.style = style;
    }

    /// Returns the effective playback time with the global offset applied.
    pub fn effective_time(&self) -> f64 {
        self.current_time + self.style.offset_ms
    }
}
