import Emittery from "emittery";

import {
  PlaybackChange,
  PlaybackSnapshot,
  PlaybackStatus,
  TrackInfo,
} from "./types";

/**
 * Non-seek position updates are coalesced; seek always emits immediately.
 *
 * This bounds how stale the MPRIS `Position` property can be for clients that
 * poll it (up to this interval behind). 1 s keeps that imperceptible while still
 * cheap; SMTC/NowPlaying extrapolate between updates so they are unaffected.
 */
const POSITION_THROTTLE_MS = 1000;

export type PlaybackControllerEvents = {
  /** Raw, unthrottled position (seconds) — lyrics / progress telemetry. */
  timeupdate: number;
  /** Raw rate — lyrics / progress telemetry. */
  playbackratechange: number;
  /** Derived: is progress advancing smoothly? (true only while playing) — lyrics. */
  advancingchange: boolean;
  /** Derived, diffed: track metadata changed (one playId = one song). */
  trackchanged: TrackInfo | null;
  /** Album art for the current song (separate from `trackchanged`). */
  coverchanged: string | null;
  /** Derived, diffed: media-session status changed. */
  statuschanged: PlaybackStatus;
  /** Derived, throttled: position for OS media sessions. */
  positionchanged: { position: number; seeked: boolean };
  /** Derived, diffed: duration changed. */
  durationchanged: number | null;
  /** Derived, diffed: rate changed. */
  ratechanged: number;
  /** Derived, diffed: volume changed. */
  volumechanged: number;
};

/**
 * Single source of truth for playback state in the main process.
 *
 * Ingested from the frozen preload/renderer seams, normalized once, then fanned
 * out as two streams: raw telemetry (lyrics / progress UI) and diffed,
 * throttled derived state (OS media-session adapters).
 */
export default class PlaybackController extends Emittery<PlaybackControllerEvents> {
  private _snapshot: PlaybackSnapshot = {
    track: null,
    status: PlaybackStatus.Stopped,
    position: null,
    duration: null,
    rate: 1,
    volume: 1,
  };

  private lastPositionEmitAt = 0;
  private pendingPosition: number | null = null;
  private positionTimer: ReturnType<typeof setTimeout> | null = null;
  private cover: string | null = null;

  get snapshot(): Readonly<PlaybackSnapshot> {
    return this._snapshot;
  }

  /** Frozen seam: `player.setInfo` → `mediaSession.setMetadata`. */
  setTrack(track: TrackInfo | null): void {
    // A playId uniquely identifies one song, so a same-id `setInfo` (e.g. the
    // duplicate around `player.setCover`) is not a track change.
    if (this._snapshot.track?.id === track?.id) return; // unchanged song
    this._snapshot.track = track;
    if (track === null) {
      // No track → always Stopped.
      this._snapshot.position = null;
      if (this._snapshot.status !== PlaybackStatus.Stopped) {
        this._snapshot.status = PlaybackStatus.Stopped;
        this.emit("statuschanged", PlaybackStatus.Stopped);
      }
    }
    this.emit("trackchanged", track);
  }

  /** Frozen seam: `player.setCover` → `mediaSession.setCover`. */
  applyCover(artUrl: string | null): void {
    if (this.cover === artUrl) return;
    this.cover = artUrl;
    this.emit("coverchanged", artUrl);
  }

  applyPosition(position: number | null, seeked = false): void {
    this._snapshot.position = position;
    if (position === null) {
      // Reset sentinel before a new track; nothing to emit.
      this.cancelPositionThrottle();
      return;
    }
    this.emit("timeupdate", position); // telemetry: always, unthrottled
    if (seeked) {
      this.cancelPositionThrottle();
      this.emit("positionchanged", { position, seeked: true });
    } else {
      this.schedulePositionEmit(position);
    }
  }

  applyDuration(duration: number | null): void {
    if (this._snapshot.duration === duration) return;
    this._snapshot.duration = duration;
    this.emit("durationchanged", duration);
  }

  applyPlaybackChange(change: PlaybackChange): void {
    // Lyrics telemetry: progress advances smoothly only while playing.
    this.emit("advancingchange", change === PlaybackChange.Playing);

    // No track → always Stopped, regardless of transient transitions.
    if (this._snapshot.track === null) {
      if (this._snapshot.status !== PlaybackStatus.Stopped) {
        this._snapshot.status = PlaybackStatus.Stopped;
        this.emit("statuschanged", PlaybackStatus.Stopped);
      }
      return;
    }

    let next = this._snapshot.status;
    switch (change) {
      case PlaybackChange.Playing:
        next = PlaybackStatus.Playing;
        break;
      case PlaybackChange.Paused:
        next = PlaybackStatus.Paused;
        break;
      case PlaybackChange.Stopped:
        next = PlaybackStatus.Stopped;
        break;
      case PlaybackChange.Stalled:
      case PlaybackChange.Seeking:
        return; // transient — media-session status unchanged
    }
    if (next !== this._snapshot.status) {
      this._snapshot.status = next;
      this.emit("statuschanged", next);
    }
  }

  applyRate(rate: number): void {
    if (this._snapshot.rate === rate) return;
    this._snapshot.rate = rate;
    this.emit("playbackratechange", rate); // telemetry
    this.emit("ratechanged", rate); // derived
  }

  applyVolume(volume: number): void {
    if (this._snapshot.volume === volume) return;
    this._snapshot.volume = volume;
    this.emit("volumechanged", volume);
  }

  private schedulePositionEmit(position: number): void {
    this.pendingPosition = position;
    if (this.positionTimer) return; // already scheduled
    const elapsed = Date.now() - this.lastPositionEmitAt;
    const delay = Math.max(0, POSITION_THROTTLE_MS - elapsed);
    this.positionTimer = setTimeout(() => this.flushPosition(), delay);
  }

  private flushPosition(): void {
    this.positionTimer = null;
    const position = this.pendingPosition;
    this.pendingPosition = null;
    if (position === null) return;
    this.lastPositionEmitAt = Date.now();
    this.emit("positionchanged", { position, seeked: false });
  }

  private cancelPositionThrottle(): void {
    if (this.positionTimer) {
      clearTimeout(this.positionTimer);
      this.positionTimer = null;
    }
    this.pendingPosition = null;
  }
}
