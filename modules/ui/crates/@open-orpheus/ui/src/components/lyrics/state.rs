use std::time::Instant;

use super::types::{LyricsData, LyricsStyle};

/// How long without a `set_time` call before we consider playback stopped.
const STALE_THRESHOLD_MS: f64 = 500.0;

/// Mutable state for the lyrics widget, updated externally by the host.
pub struct LyricsState {
    /// Current playback time in milliseconds (last received from JS).
    pub current_time: f64,
    /// Instant when `set_time` was last called.
    last_update: Instant,
    /// Whether we believe audio is currently playing.
    pub playing: bool,
    /// The parsed lyrics data (primary + optional secondary).
    pub data: Option<LyricsData>,
    /// Visual styling configuration.
    pub style: LyricsStyle,
}

impl Default for LyricsState {
    fn default() -> Self {
        Self {
            current_time: 0.0,
            last_update: Instant::now(),
            playing: false,
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
        self.last_update = Instant::now();
        self.playing = true;
    }

    /// Set the lyrics data. Pass `None` to clear.
    pub fn set_data(&mut self, data: Option<LyricsData>) {
        self.data = data;
    }

    /// Replace the visual style.
    pub fn set_style(&mut self, style: LyricsStyle) {
        self.style = style;
    }

    /// Returns the effective playback time, interpolated between JS updates
    /// for smooth per-frame progress. Automatically detects pause via
    /// staleness (no `set_time` call for 500ms).
    pub fn effective_time(&mut self) -> f64 {
        if self.playing {
            let elapsed_ms = self.last_update.elapsed().as_secs_f64() * 1000.0;
            if elapsed_ms > STALE_THRESHOLD_MS {
                self.playing = false;
                self.current_time + self.style.offset_ms
            } else {
                self.current_time + elapsed_ms + self.style.offset_ms
            }
        } else {
            self.current_time + self.style.offset_ms
        }
    }
}
