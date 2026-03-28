pub mod layout;
pub mod state;
pub mod text_effects;
pub mod types;
pub mod widget;

pub use state::LyricsState;
pub use types::{LineMode, LyricLine, LyricWord, LyricsData, LyricsStyle};
pub use widget::LyricsWidget;
