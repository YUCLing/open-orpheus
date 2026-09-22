import Emittery from "emittery";

import { PlaybackStatus, TrackInfo } from "../types";

/** Commands from an OS media session, normalized before hitting the renderer. */
export type PlayerCommandEvents = {
  play: undefined;
  pause: undefined;
  toggle: undefined;
  next: undefined;
  previous: undefined;
  /** Relative seek, seconds (signed). */
  seek: number;
  /** Absolute seek, seconds. */
  setPosition: number;
  /** Volume, 0..1. */
  volume: number;
  raise: undefined;
  quit: undefined;
};

/**
 * Platform media-session integration (MPRIS / SMTC / MPNowPlayingInfo).
 *
 * The `PlaybackController` pushes derived state (in seconds / plain values); the
 * adapter translates to its platform's native calls and owns all unit
 * conversion. Commands coming *from* the OS are re-emitted here and forwarded
 * to the renderer by the `PlayerCommandRouter`.
 */
export interface MediaSessionAdapter extends Emittery<PlayerCommandEvents> {
  onTrack(track: TrackInfo | null): void;
  /** Album art for the current song. */
  onArtwork(artUrl: string | null): void;
  onStatus(status: PlaybackStatus): void;
  /** Seconds. `seeked` is true when the position changed discontinuously. */
  onPosition(position: number, seeked: boolean): void;
  /** Seconds, or null when unknown. */
  onDuration(duration: number | null): void;
  onRate(rate: number): void;
  onVolume(volume: number): void;
  dispose(): void;
}

/** Platform without media-session support. */
export class NoopAdapter
  extends Emittery<PlayerCommandEvents>
  implements MediaSessionAdapter
{
  onTrack(): void {}
  onArtwork(): void {}
  onStatus(): void {}
  onPosition(): void {}
  onDuration(): void {}
  onRate(): void {}
  onVolume(): void {}
  dispose(): void {}
}
