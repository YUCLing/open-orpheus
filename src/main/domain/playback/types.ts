/** Real playback state, as reported to OS media-session integrations. */
export enum PlaybackStatus {
  Playing = "playing",
  Paused = "paused",
  Stopped = "stopped",
}

/**
 * A single playback transition emitted by the preload (`player.playbackchange`).
 * The controller derives both the media-session status and the lyrics
 * "is progress advancing smoothly?" boolean from these.
 */
export enum PlaybackChange {
  Playing = "playing",
  Paused = "paused",
  Stopped = "stopped",
  Stalled = "stalled",
  Seeking = "seeking",
}

/** Track metadata. */
export interface TrackInfo {
  id: string;
  title: string;
  artist: string;
  album: string;
}

/**
 * Single source of truth for playback state, in seconds / plain values.
 * OS media-session adapters own any unit conversion (µs, ticks, …).
 */
export interface PlaybackSnapshot {
  track: TrackInfo | null;
  status: PlaybackStatus;
  position: number | null;
  duration: number | null;
  rate: number;
  volume: number;
}
