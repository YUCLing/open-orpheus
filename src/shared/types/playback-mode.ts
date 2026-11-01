/** Modes exposed by the Orpheus renderer's playing model. */
export type PlaybackMode =
  | "playOrder"
  | "playCycle"
  | "playOneCycle"
  | "playRandom"
  | "playAi"
  | "playFm";

export type LoopStatus = "None" | "Playlist" | "Track";
