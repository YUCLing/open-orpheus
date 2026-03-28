use std::sync::Arc;

use egui::text::{Galley, LayoutJob, TextWrapping};
use egui::{Align, FontId, Pos2, Vec2};

use super::types::{LineMode, LyricLine, LyricWord, LyricsData, LyricsStyle};

/// The result of laying out visible lyrics for a single frame.
pub struct LyricsLayout {
    /// The lines to render this frame, in display order (top to bottom).
    pub visible_lines: Vec<VisibleLine>,
}

/// A single line to be rendered, with its pre-computed galley and metadata.
pub struct VisibleLine {
    /// The laid-out text, ready for rendering.
    pub galley: Arc<Galley>,
    /// Position to render at (relative to widget origin).
    pub pos: Pos2,
    /// Playback progress through this line (0.0–1.0).
    pub progress: f32,
    /// Whether this line is the currently active (playing) primary line.
    pub is_active: bool,
    /// Scroll offset when line text overflows the available width.
    pub scroll_offset: f32,
    /// Text alignment for this line.
    pub align: Align,
}

/// Finds the index of the line that should be active at the given time.
/// Returns `None` if no line matches (e.g. before the first line or after the last).
pub fn find_current_line(lines: &[LyricLine], time: f64) -> Option<usize> {
    // Binary search: find the last line whose start_time <= time.
    if lines.is_empty() {
        return None;
    }

    let mut result = None;
    let mut lo = 0usize;
    let mut hi = lines.len();
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if lines[mid].start_time <= time {
            result = Some(mid);
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }

    // If the found line has already ended, look for a gap.
    if let Some(idx) = result
        && time > lines[idx].end_time
    {
        // We're in a gap between lines. Show nothing or the upcoming line
        // depending on how close we are.
        let next = idx + 1;
        if next < lines.len() {
            let gap = lines[next].start_time - lines[idx].end_time;
            let into_gap = time - lines[idx].end_time;
            // If we're in the latter half of the gap, show the next line.
            if into_gap > gap * 0.5 {
                return Some(next);
            }
        }
        // Stay on previous line (progress will be 1.0)
    }

    result
}

/// Computes the playback progress of a lyric line at the given time.
///
/// For lines with a single word (plain LRC), this is a simple linear
/// interpolation. For multi-word lines (YRC/KRC), this computes per-word
/// progress and maps it to a text position fraction.
pub fn compute_line_progress(line: &LyricLine, time: f64) -> f32 {
    if time <= line.start_time {
        return 0.0;
    }
    if time >= line.end_time {
        return 1.0;
    }

    if line.words.len() <= 1 {
        // Simple linear interpolation for the whole line.
        let duration = line.duration();
        if duration <= 0.0 {
            return 1.0;
        }
        return ((time - line.start_time) / duration) as f32;
    }

    // Per-word progress: find which word is currently playing and compute
    // the fraction of total text width that has been played.
    compute_per_word_progress(&line.words, time, line.start_time)
}

/// Given per-word timing data, computes the fractional text position of
/// the current playback point.
fn compute_per_word_progress(words: &[LyricWord], time: f64, line_start: f64) -> f32 {
    let total_chars: usize = words.iter().map(|w| w.text.len()).sum();
    if total_chars == 0 {
        return 0.0;
    }

    let mut chars_before = 0usize;

    for word in words {
        let word_start = line_start + word.start_time;
        let word_end = word_start + word.duration;
        let word_chars = word.text.len();

        if time < word_start {
            // Haven't reached this word yet.
            return chars_before as f32 / total_chars as f32;
        }

        if time >= word_end {
            // Fully past this word.
            chars_before += word_chars;
            continue;
        }

        // Currently within this word — compute sub-word progress.
        let word_progress = if word.duration > 0.0 {
            ((time - word_start) / word.duration) as f32
        } else {
            1.0
        };

        let fractional_chars = chars_before as f32 + word_chars as f32 * word_progress;
        return fractional_chars / total_chars as f32;
    }

    1.0
}

/// Computes the scroll offset for a line that overflows the available width.
/// The offset tracks the playback progress so the currently playing portion
/// is always visible.
pub fn compute_scroll_offset(galley_width: f32, available_width: f32, progress: f32) -> f32 {
    let overflow = galley_width - available_width;
    if overflow <= 0.0 {
        return 0.0;
    }
    // Scroll so the progress point is centered when possible.
    let target = progress * galley_width - available_width * 0.5;
    target.clamp(0.0, overflow)
}

/// Builds a `LayoutJob` for a lyric line with the specified font.
/// The job is configured for no-wrap (single line) so we can handle overflow
/// ourselves via scrolling. Alignment is handled externally by the layout
/// engine (e.g. `layout_horizontal`) rather than via `halign`, because
/// `halign` with `max_width = INFINITY` causes egui to offset the row
/// internally (e.g. center → `x = -width/2`), breaking clip-rect math.
pub fn build_layout_job(text: &str, font_id: FontId, _align: Align) -> LayoutJob {
    let mut job = LayoutJob::single_section(
        text.to_owned(),
        egui::text::TextFormat {
            font_id,
            color: egui::Color32::WHITE, // placeholder; overridden at render time
            ..Default::default()
        },
    );
    // halign intentionally left at default (Align::LEFT / Min).
    job.wrap = TextWrapping {
        max_width: f32::INFINITY,
        max_rows: 1,
        break_anywhere: false,
        overflow_character: None,
    };
    job
}

/// Performs horizontal layout for the lyrics widget.
pub fn layout_horizontal(
    ui: &egui::Ui,
    data: &LyricsData,
    style: &LyricsStyle,
    effective_time: f64,
    available_size: Vec2,
) -> LyricsLayout {
    let current_idx = find_current_line(&data.lines, effective_time);
    let mut visible_lines = Vec::new();

    let primary_font = style.font_id();
    let secondary_font = style.secondary_font_id();
    let line_spacing = 4.0;

    // Determine which primary line(s) to show.
    let primary_idx = current_idx.unwrap_or(0);
    let primary_line = data.lines.get(primary_idx);

    if let Some(line) = primary_line {
        let text = line.text();
        let job = build_layout_job(&text, primary_font.clone(), style.text_align[0]);
        let galley = ui.fonts_mut(|f| f.layout_job(job));
        let progress = compute_line_progress(line, effective_time);
        let scroll_offset = compute_scroll_offset(galley.size().x, available_size.x, progress);
        let is_active = current_idx == Some(primary_idx)
            && effective_time >= line.start_time
            && effective_time <= line.end_time;

        visible_lines.push(VisibleLine {
            galley,
            pos: Pos2::ZERO, // will be positioned below
            progress: if is_active {
                progress
            } else if effective_time > line.end_time {
                1.0
            } else {
                0.0
            },
            is_active,
            scroll_offset,
            align: style.text_align[0],
        });
    }

    // Second line: secondary lyrics (translation) take priority if available,
    // otherwise show the next primary line in double-line mode.
    let show_secondary = data.secondary_lines.is_some();
    let show_second_line = matches!(style.line_mode, LineMode::Double) || show_secondary;

    if show_second_line {
        if let Some(secondary_lines) = &data.secondary_lines {
            // Find the secondary line for the current time.
            let sec_idx = find_current_line(secondary_lines, effective_time);
            if let Some(idx) = sec_idx
                && let Some(sec_line) = secondary_lines.get(idx)
            {
                let text = sec_line.text();
                let job = build_layout_job(&text, secondary_font.clone(), style.text_align[1]);
                let galley = ui.fonts_mut(|f| f.layout_job(job));
                let progress = compute_line_progress(sec_line, effective_time);
                let scroll_offset =
                    compute_scroll_offset(galley.size().x, available_size.x, progress);

                visible_lines.push(VisibleLine {
                    galley,
                    pos: Pos2::ZERO,
                    progress: 0.0, // secondary lines don't show progress coloring
                    is_active: false,
                    scroll_offset,
                    align: style.text_align[1],
                });
            }
        } else if matches!(style.line_mode, LineMode::Double) {
            // Show next primary line.
            let next_idx = primary_idx + 1;
            if let Some(next_line) = data.lines.get(next_idx) {
                let text = next_line.text();
                let job = build_layout_job(&text, primary_font.clone(), style.text_align[1]);
                let galley = ui.fonts_mut(|f| f.layout_job(job));

                visible_lines.push(VisibleLine {
                    galley,
                    pos: Pos2::ZERO,
                    progress: 0.0,
                    is_active: false,
                    scroll_offset: 0.0,
                    align: style.text_align[1],
                });
            }
        }
    }

    // Position lines vertically: center them within the available height.
    let total_height: f32 = visible_lines.iter().map(|l| l.galley.size().y).sum::<f32>()
        + (visible_lines.len().saturating_sub(1) as f32) * line_spacing;

    let start_y = (available_size.y - total_height) * 0.5;
    let mut y = start_y.max(0.0);

    for line in &mut visible_lines {
        let galley_width = line.galley.size().x;
        let x = match line.align {
            Align::Min => -line.scroll_offset,
            Align::Center => ((available_size.x - galley_width) * 0.5 - line.scroll_offset)
                .max(-(galley_width - available_size.x).max(0.0)),
            Align::Max => available_size.x - galley_width - line.scroll_offset,
        };
        line.pos = Pos2::new(x, y);
        y += line.galley.size().y + line_spacing;
    }

    LyricsLayout { visible_lines }
}

/// Performs vertical layout (CJK vertical text) for the lyrics widget.
pub fn layout_vertical(
    ui: &egui::Ui,
    data: &LyricsData,
    style: &LyricsStyle,
    effective_time: f64,
    available_size: Vec2,
) -> LyricsLayout {
    let current_idx = find_current_line(&data.lines, effective_time);
    let primary_font = style.font_id();
    let secondary_font = style.secondary_font_id();
    let column_spacing = 8.0;
    let mut visible_lines = Vec::new();

    let primary_idx = current_idx.unwrap_or(0);

    if let Some(line) = data.lines.get(primary_idx) {
        let text = line.text();
        // For vertical layout, render each character on its own line.
        let vertical_text = interleave_newlines(&text);
        let job = build_layout_job(&vertical_text, primary_font.clone(), Align::Center);
        let galley = ui.fonts_mut(|f| f.layout_job(job));
        let progress = compute_line_progress(line, effective_time);
        let scroll_offset = compute_scroll_offset(galley.size().y, available_size.y, progress);
        let is_active = current_idx == Some(primary_idx)
            && effective_time >= line.start_time
            && effective_time <= line.end_time;

        visible_lines.push(VisibleLine {
            galley,
            pos: Pos2::ZERO,
            progress: if is_active {
                progress
            } else if effective_time > line.end_time {
                1.0
            } else {
                0.0
            },
            is_active,
            scroll_offset,
            align: Align::Center,
        });
    }

    // Secondary line in vertical mode.
    let show_secondary = data.secondary_lines.is_some();
    let show_second = matches!(style.line_mode, LineMode::Double) || show_secondary;

    if show_second {
        if let Some(secondary_lines) = &data.secondary_lines {
            let sec_idx = find_current_line(secondary_lines, effective_time);
            if let Some(idx) = sec_idx
                && let Some(sec_line) = secondary_lines.get(idx)
            {
                let text = sec_line.text();
                let vertical_text = interleave_newlines(&text);
                let job = build_layout_job(&vertical_text, secondary_font.clone(), Align::Center);
                let galley = ui.fonts_mut(|f| f.layout_job(job));
                let scroll_offset = compute_scroll_offset(galley.size().y, available_size.y, 0.0);

                visible_lines.push(VisibleLine {
                    galley,
                    pos: Pos2::ZERO,
                    progress: 0.0,
                    is_active: false,
                    scroll_offset,
                    align: Align::Center,
                });
            }
        } else if matches!(style.line_mode, LineMode::Double) {
            let next_idx = primary_idx + 1;
            if let Some(next_line) = data.lines.get(next_idx) {
                let text = next_line.text();
                let vertical_text = interleave_newlines(&text);
                let job = build_layout_job(&vertical_text, primary_font.clone(), Align::Center);
                let galley = ui.fonts_mut(|f| f.layout_job(job));

                visible_lines.push(VisibleLine {
                    galley,
                    pos: Pos2::ZERO,
                    progress: 0.0,
                    is_active: false,
                    scroll_offset: 0.0,
                    align: Align::Center,
                });
            }
        }
    }

    // Position columns right-to-left (traditional CJK vertical reading order).
    let total_width: f32 = visible_lines.iter().map(|l| l.galley.size().x).sum::<f32>()
        + (visible_lines.len().saturating_sub(1) as f32) * column_spacing;

    let start_x = available_size.x - (available_size.x - total_width) * 0.5;
    let mut x = start_x;

    for line in &mut visible_lines {
        x -= line.galley.size().x;
        let galley_height = line.galley.size().y;
        let y = match line.align {
            Align::Min => -line.scroll_offset,
            Align::Center => ((available_size.y - galley_height) * 0.5 - line.scroll_offset)
                .max(-(galley_height - available_size.y).max(0.0)),
            Align::Max => available_size.y - galley_height - line.scroll_offset,
        };
        line.pos = Pos2::new(x, y);
        x -= column_spacing;
    }

    LyricsLayout { visible_lines }
}

/// Inserts a newline between each character for vertical text rendering.
fn interleave_newlines(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut result = String::with_capacity(chars.len() * 2);
    for (i, ch) in chars.iter().enumerate() {
        result.push(*ch);
        if i + 1 < chars.len() {
            result.push('\n');
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_line_progress_simple() {
        let line = LyricLine {
            start_time: 1000.0,
            end_time: 5000.0,
            words: vec![LyricWord {
                text: "Hello World".into(),
                start_time: 0.0,
                duration: 4000.0,
            }],
        };
        assert_eq!(compute_line_progress(&line, 500.0), 0.0);
        assert_eq!(compute_line_progress(&line, 1000.0), 0.0);
        assert!((compute_line_progress(&line, 3000.0) - 0.5).abs() < 0.01);
        assert_eq!(compute_line_progress(&line, 5000.0), 1.0);
        assert_eq!(compute_line_progress(&line, 6000.0), 1.0);
    }

    #[test]
    fn test_compute_line_progress_per_word() {
        let line = LyricLine {
            start_time: 0.0,
            end_time: 3000.0,
            words: vec![
                LyricWord {
                    text: "He".into(),
                    start_time: 0.0,
                    duration: 1000.0,
                },
                LyricWord {
                    text: "llo".into(),
                    start_time: 1000.0,
                    duration: 2000.0,
                },
            ],
        };
        // "He" = 2 chars, "llo" = 3 chars, total = 5
        // At t=0: progress = 0/5 = 0
        assert_eq!(compute_line_progress(&line, 0.0), 0.0);
        // At t=500: halfway through "He": (0 + 2*0.5)/5 = 1/5 = 0.2
        assert!((compute_line_progress(&line, 500.0) - 0.2).abs() < 0.01);
        // At t=1000: "He" fully played: 2/5 = 0.4
        assert!((compute_line_progress(&line, 1000.0) - 0.4).abs() < 0.01);
        // At t=2000: "He" + half of "llo": (2 + 3*0.5)/5 = 3.5/5 = 0.7
        assert!((compute_line_progress(&line, 2000.0) - 0.7).abs() < 0.01);
        // At t=3000: done
        assert_eq!(compute_line_progress(&line, 3000.0), 1.0);
    }

    #[test]
    fn test_find_current_line() {
        let lines = vec![
            LyricLine {
                start_time: 0.0,
                end_time: 2000.0,
                words: vec![],
            },
            LyricLine {
                start_time: 3000.0,
                end_time: 5000.0,
                words: vec![],
            },
            LyricLine {
                start_time: 6000.0,
                end_time: 8000.0,
                words: vec![],
            },
        ];

        assert_eq!(find_current_line(&lines, 1000.0), Some(0));
        assert_eq!(find_current_line(&lines, 4000.0), Some(1));
        // In gap between line 0 end (2000) and line 1 start (3000):
        // At 2800, which is >50% of the 1000ms gap, should jump to next.
        assert_eq!(find_current_line(&lines, 2800.0), Some(1));
        // At 2200, which is <50% of the gap, stay on previous.
        assert_eq!(find_current_line(&lines, 2200.0), Some(0));
    }

    #[test]
    fn test_scroll_offset() {
        // No overflow
        assert_eq!(compute_scroll_offset(100.0, 200.0, 0.5), 0.0);
        // Overflow
        let offset = compute_scroll_offset(300.0, 200.0, 0.5);
        // progress 0.5 → target = 0.5*300 - 200*0.5 = 150 - 100 = 50
        assert!((offset - 50.0).abs() < 0.01);
        // At start, clamped to 0
        assert_eq!(compute_scroll_offset(300.0, 200.0, 0.0), 0.0);
        // At end, clamped to overflow (100)
        assert_eq!(compute_scroll_offset(300.0, 200.0, 1.0), 100.0);
    }
}
