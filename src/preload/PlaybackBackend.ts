import type { AudioPlayInfo } from "./Player";

/**
 * The uniform media events a playback backend raises. `Player` re-emits these
 * as its typed `PlayerEvents`, so consumers never touch the underlying engine.
 * `load` is the backend's readiness signal ("can play now").
 */
export type PlaybackEventName =
  | "load"
  | "play"
  | "playing"
  | "pause"
  | "ended"
  | "error"
  | "stalled"
  | "seeking"
  | "seeked"
  | "timeupdate"
  | "durationchange"
  | "ratechange";

/** Callback through which a backend reports media events to `Player`. */
export type PlaybackEventSink = (
  name: PlaybackEventName,
  data?: unknown
) => void;

/**
 * A playback engine behind `Player`'s media surface: either the hidden
 * `<audio>` element or the AV3A decode backend. `Player` holds whichever is
 * active and delegates every transport/state call to it; it never branches on
 * which one it is.
 */
export interface PlaybackBackend {
  /** Node feeding the effect chain and audio-data capture (null until ready). */
  readonly sourceNode: AudioNode | null;

  /** Start playing `playInfo`. Raises `load` when playback can start. */
  load(playInfo: AudioPlayInfo): Promise<void>;

  play(): Promise<void>;
  pause(): void;
  stop(): void;

  /** Seek to a content time in seconds. */
  seek(seconds: number): void;

  readonly currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly playbackRate: number;
  setPlaybackRate(rate: number): void;

  /** Release resources (media source / decode session). */
  dispose(): Promise<void>;
}
