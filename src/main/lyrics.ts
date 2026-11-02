import LyricsDispatcher from "./lyrics/LyricsDispatcher";
import { playbackController } from "./mediaSession";

export const lyricsDispatcher = new LyricsDispatcher();

// Lyrics update events are handled in calls.

playbackController.on("timeupdate", ({ data }) => {
  lyricsDispatcher.time = data;
});
playbackController.on("playbackratechange", ({ data }) => {
  lyricsDispatcher.playbackRate = data;
});
playbackController.on("advancingchange", ({ data }) => {
  lyricsDispatcher.playState = data;
});
playbackController.on("trackchanged", () => {
  LOGGER.debug("Cleared lyrics for track change");
  if (lyricsDispatcher.lyrics !== null) lyricsDispatcher.lyrics = null;
  if (lyricsDispatcher.slogan !== null) lyricsDispatcher.slogan = null;
});
