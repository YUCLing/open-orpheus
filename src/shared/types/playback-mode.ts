/** Modes exposed by the Orpheus renderer's playing model. */
export type PlaybackMode =
  | "playOrder"
  | "playCycle"
  | "playOneCycle"
  | "playRandom"
  | "playAi"
  | "playFm";

export type LoopStatus = "None" | "Playlist" | "Track";

export function isPlaybackMode(mode: unknown): mode is PlaybackMode {
  return ["playOrder", "playCycle", "playOneCycle", "playRandom", "playAi", "playFm"].includes(
    mode as string
  );
}

export function mprisPlaybackMode(mode: PlaybackMode): {
  loopStatus: LoopStatus;
  shuffle: boolean;
} {
  return {
    loopStatus:
      mode === "playOneCycle"
        ? "Track"
        : mode === "playCycle" || mode === "playRandom"
          ? "Playlist"
          : "None",
    shuffle: mode === "playRandom",
  };
}

/** Orpheus has one mutually exclusive mode; report its actual combination. */
export function modeForLoopStatus(mode: PlaybackMode, loopStatus: LoopStatus): PlaybackMode {
  if (loopStatus === "Track") return "playOneCycle";
  if (loopStatus === "None") return "playOrder";
  return mode === "playRandom" ? mode : "playCycle";
}

export function modeForShuffle(mode: PlaybackMode, shuffle: boolean): PlaybackMode {
  return shuffle ? "playRandom" : mode === "playRandom" ? "playCycle" : mode;
}
