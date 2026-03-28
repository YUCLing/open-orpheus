pub mod layout;
pub mod state;
pub mod text_effects;
pub mod types;
pub mod widget;

pub use state::LyricsState;
pub use types::{LineMode, LyricLine, LyricWord, LyricsData, LyricsStyle, LyricsStyleDto};
pub use widget::LyricsWidget;
