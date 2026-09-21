import Emittery from "emittery";

import type { MainWindowAccessor } from "../bootstrap/types";
import { PlayerCommandEvents } from "./adapters/MediaSessionAdapter";
import type PlaybackController from "./PlaybackController";
import { PlaybackStatus } from "./types";

/**
 * How long an unconfirmed toggle is honoured before the backlog is dropped.
 * Long enough to cover a resume that buffers first (the renderer may not report
 * `playing` until the stream is ready), short enough that a toggle the renderer
 * never acknowledges cannot wedge the controls.
 */
const INTENT_TTL_MS = 3000;

/**
 * Translates media-session commands (MPRIS / SMTC / MPNowPlayingInfo adapters)
 * into the renderer-facing IPC the preload already understands.
 *
 * This is the only place that maps abstract commands onto the two distinct
 * seek semantics the preload exposes: `player.seek` (relative delta) vs
 * `player.seekto` (absolute position).
 *
 * Playback is the exception: the OS sends absolute intents (`play` / `pause`)
 * but the renderer only exposes a *toggle*, so this router decides whether a
 * toggle is warranted and tracks the toggles still in flight.
 */
export default class PlayerCommandRouter {
  /**
   * Status expected after each in-flight toggle lands, oldest first.
   *
   * A toggle is only reported back *after* it lands, so without this every
   * request issued in the meantime reads the same stale snapshot — and since a
   * toggle is not idempotent, an even number of them lands back where it
   * started. Tracking them in order also keeps an earlier confirmation from
   * being mistaken for a later toggle having landed.
   */
  private readonly inflight: PlaybackStatus[] = [];
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param player Playback state source, read on demand.
   */
  constructor(
    commands: Emittery<PlayerCommandEvents>,
    private readonly player: PlaybackController,
    private readonly windows: MainWindowAccessor
  ) {
    // The renderer reports every transition through `player.playbackchange`,
    // which the controller folds into `statuschanged`.
    player.on("statuschanged", ({ data }) => this.confirm(data));

    commands.on("play", () => this.request(PlaybackStatus.Playing));
    commands.on("pause", () => this.request(PlaybackStatus.Paused));
    commands.on("toggle", () => this.toggle());
    commands.on("next", () => this.sendHotkey("next_1"));
    commands.on("previous", () => this.sendHotkey("prev_1"));
    commands.on("seek", ({ data }) => this.send("player.seek", data));
    commands.on("setPosition", ({ data }) => this.send("player.seekto", data));
    commands.on("volume", ({ data }) => this.send("player.volume", data));
  }

  /** Where playback is headed once every in-flight toggle has landed. */
  private get intended(): PlaybackStatus {
    const last = this.inflight[this.inflight.length - 1];
    return last ?? this.player.snapshot.status;
  }

  /**
   * Forward an absolute OS intent as the renderer's toggle, unless playback is
   * already there or already on the way.
   *
   * `Stopped` is a valid *source* for play, unlike for pause: a finished or
   * errored song keeps its track, so an explicit play must be able to revive
   * it. Pausing from `Stopped` is meaningless and must not toggle.
   */
  private request(target: PlaybackStatus): void {
    const from = this.intended;
    if (from === target) return;

    if (target === PlaybackStatus.Playing) {
      // No retained track to resume (the controller forces Stopped with none).
      if (
        from === PlaybackStatus.Stopped &&
        this.player.snapshot.track === null
      )
        return;
    } else if (from !== PlaybackStatus.Playing) {
      return;
    }

    this.toggleTowards(target);
  }

  /**
   * An explicit toggle is always honoured; queueing where it lands keeps
   * follow-up play/pause requests idempotent until it is confirmed.
   */
  private toggle(): void {
    this.toggleTowards(
      this.intended === PlaybackStatus.Playing
        ? PlaybackStatus.Paused
        : PlaybackStatus.Playing
    );
  }

  private toggleTowards(target: PlaybackStatus): void {
    this.inflight.push(target);
    this.armExpiry();
    this.sendHotkey("play_pause_3");
  }

  /**
   * Retire the toggle a renderer transition accounts for — or, when it matches
   * none, trust the report and drop the backlog (the transition was not ours to
   * explain: an out-of-band change, or several toggles landing as one).
   *
   * Retiring only on a *matching* transition is what keeps a queued pause alive
   * while the earlier play confirms. Clearing unconditionally would forget the
   * pause, and the next `pause` would fire a third toggle that cancels it.
   */
  private confirm(status: PlaybackStatus): void {
    if (this.inflight[0] === status) {
      this.inflight.shift();
    } else {
      this.inflight.length = 0;
    }
    if (this.inflight.length === 0) this.clearExpiry();
    else this.armExpiry();
  }

  private armExpiry(): void {
    this.clearExpiry();
    // Safety net: if the renderer never reports a toggle — e.g. a request that
    // errors and re-reports the same status, which the controller suppresses as
    // a no-op — don't wedge every later request on a stale backlog.
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.inflight.length = 0;
    }, INTENT_TTL_MS);
  }

  private clearExpiry(): void {
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  private send(channel: string, ...args: unknown[]): void {
    this.windows.current()?.webContents.send(channel, ...args);
  }

  private sendHotkey(name: string): void {
    this.windows.current()?.webContents.send(
      "channel.call",
      "winhelper.onHotkey",
      name,
      true
    );
  }
}
