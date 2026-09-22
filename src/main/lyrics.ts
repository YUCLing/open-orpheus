import LyricsDispatcher from "./lyrics/LyricsDispatcher";
import type PlaybackController from "./playback/PlaybackController";

export const lyricsDispatcher = new LyricsDispatcher();

// Lyrics update events are handled in ipc.

export function bindLyrics(playbackController: PlaybackController) {
  playbackController.on("timeupdate", ({ data }) => {
    lyricsDispatcher.time = data;
  });
  playbackController.on("playbackratechange", ({ data }) => {
    lyricsDispatcher.playbackRate = data;
  });
  playbackController.on("advancingchange", ({ data }) => {
    lyricsDispatcher.playState = data;
  });
}
