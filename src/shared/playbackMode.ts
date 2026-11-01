import type { PlaybackMode } from "./types/playback-mode";

export function isPlaybackMode(mode: unknown): mode is PlaybackMode {
  return ["playOrder", "playCycle", "playOneCycle", "playRandom", "playAi", "playFm"].includes(
    mode as string
  );
}
