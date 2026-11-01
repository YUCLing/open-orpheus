import type { LyricsStore } from "@shared/types/lyrics";
import type { TrackInfo } from "../playback/types";

/**
 * The shape NAPI expects for a single timed word.
 *
 * The native struct uses snake_case Rust fields, which napi-rs reports as
 * camelCase properties on the JS side. The conversion helpers below bridge the
 * app's snake_case `LyricsStore` fields to this boundary.
 */
export interface DbusLyricsWord {
  text: string;
  startTime: number;
  duration: number;
}

/** The shape NAPI expects for a single lyric line. */
export interface DbusLyricsLine {
  startTime: number;
  endTime: number;
  words: DbusLyricsWord[];
}

/** The shape NAPI expects for `setLyrics`. */
export interface DbusLyricsDocument {
  regular: DbusLyricsLine[];
  perWord?: DbusLyricsLine[];
  translate?: DbusLyricsLine[];
  roma?: DbusLyricsLine[];
}

/** The shape NAPI expects for `setTrack`. Duration is in milliseconds. */
export interface DbusLyricsTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration?: number;
}

/** The subset of the native `LyricsService` this adapter needs. */
export interface LyricsServiceHandle {
  setTrack(track?: DbusLyricsTrack | null): Promise<void>;
  setLyrics(lyrics?: DbusLyricsDocument | null, slogan?: string | null): Promise<void>;
  dispose(): Promise<void>;
}

/** The lyrics state this adapter reads from. */
export interface LyricsSource {
  readonly lyrics: LyricsStore | null;
  readonly slogan: string | null;
  on(
    event: "lyricsupdate" | "sloganupdate",
    listener: (event: { name: string; data: unknown }) => void
  ): () => void;
}

/** The playback state this adapter reads from. */
export interface PlaybackSource {
  readonly snapshot: {
    readonly track: TrackInfo | null;
    readonly duration: number | null;
  };
  on(
    event: "trackchanged" | "durationchanged",
    listener: (event: { name: string; data: unknown }) => void
  ): () => void;
}

export interface DbusLyricsServiceOptions {
  service: LyricsServiceHandle;
  lyrics: LyricsSource;
  playback: PlaybackSource;
  /** Reports a failed native update without stopping later updates. */
  onError?: (error: unknown, operation: string) => void;
}

/** Map the app's snake_case line shape onto the NAPI camelCase shape. */
function toDbusLine(line: LyricsStore["regular"][number]): DbusLyricsLine {
  return {
    startTime: line.start_time,
    endTime: line.end_time,
    words: line.words.map((word) => ({
      text: word.text,
      startTime: word.start_time,
      duration: word.duration,
    })),
  };
}

/** Map `LyricsStore` onto the native document, preserving optional variants. */
export function toDbusLyricsDocument(store: LyricsStore | null): DbusLyricsDocument | null {
  if (!store) return null;

  return {
    regular: store.regular.map(toDbusLine),
    perWord: store["per-word"]?.map(toDbusLine),
    translate: store.translate?.map(toDbusLine),
    roma: store.roma?.map(toDbusLine),
  };
}

/** Map a track and its duration (seconds) onto the native track (milliseconds). */
export function toDbusLyricsTrack(
  track: TrackInfo | null,
  durationSeconds: number | null
): DbusLyricsTrack | null {
  if (!track) return null;

  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: durationSeconds === null ? undefined : Math.round(durationSeconds * 1000),
  };
}

/**
 * Mirrors the current lyrics/track state into the native D-Bus lyrics service.
 *
 * Only existing `LyricsDispatcher` / `PlaybackController` events are used; the
 * adapter never touches the player or the renderer. Writes are serialized so a
 * burst of events cannot land out of order, and identical state is not pushed
 * again.
 */
export default class DbusLyricsService {
  private readonly service: LyricsServiceHandle;
  private readonly lyrics: LyricsSource;
  private readonly playback: PlaybackSource;
  private readonly onError: (error: unknown, operation: string) => void;
  private readonly unsubscribers: Array<() => void> = [];

  private queue: Promise<void> = Promise.resolve();
  private disposePromise: Promise<void> | null = null;

  /** `undefined` is the "never pushed" sentinel. */
  private lastLyrics: LyricsStore | null | undefined;
  private lastSlogan: string | null | undefined;
  private lastTrackKey: string | undefined;

  constructor({ service, lyrics, playback, onError }: DbusLyricsServiceOptions) {
    this.service = service;
    this.lyrics = lyrics;
    this.playback = playback;
    this.onError = onError ?? (() => {});

    this.unsubscribers.push(
      lyrics.on("lyricsupdate", () => this.refreshLyrics()),
      lyrics.on("sloganupdate", () => this.refreshLyrics()),
      playback.on("trackchanged", () => {
        // The renderer only pushes lyrics while a lyrics consumer is active,
        // so the previous song's lyrics may still be in the dispatcher. Clear
        // locally before publishing the new track; this also guarantees the
        // bus sees the clear before it sees the new track metadata.
        this.clearLyrics();
        this.refreshTrack();
      }),
      playback.on("durationchanged", () => this.refreshTrack())
    );

    LOGGER.debug("D-Bus lyrics service listeners installed");

    // Push whatever is already known. If the service was created after a song
    // started, this is the initial snapshot; the native side drops no-ops.
    this.refreshLyrics();
    this.refreshTrack();
  }

  /** Stop listening and close the native service. Idempotent. */
  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeOnce();
    return this.disposePromise;
  }

  private async disposeOnce(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();

    // Let already-queued writes reach the native side before closing it.
    await this.queue.catch(() => {});

    try {
      await this.service.dispose();
    } catch (error) {
      this.reportError(error, "dispose");
    }
  }

  private refreshLyrics(): void {
    const lyrics = this.lyrics.lyrics;
    const slogan = this.lyrics.slogan;
    if (lyrics === this.lastLyrics && slogan === this.lastSlogan) return;

    this.lastLyrics = lyrics;
    this.lastSlogan = slogan;
    const document = toDbusLyricsDocument(lyrics);
    this.enqueue("setLyrics", () => this.service.setLyrics(document, slogan));
  }

  /**
   * Forget the previous track's lyrics before the new track is published.
   *
   * The renderer only sends lyrics while a lyrics consumer is active, so the
   * dispatcher can still hold the previous song's lyrics when the track
   * changes. The dispatcher clears them too, but that happens from its own
   * event listener; clearing here synchronously guarantees the D-Bus writes
   * are queued in the safe order: clear first, then the new track.
   */
  private clearLyrics(): void {
    if (this.lastLyrics === null && this.lastSlogan === null) return;

    this.lastLyrics = null;
    this.lastSlogan = null;
    this.enqueue("setLyrics", () => this.service.setLyrics(null, null));
  }

  private refreshTrack(): void {
    const { track, duration } = this.playback.snapshot;
    const next = toDbusLyricsTrack(track, duration);
    const key = JSON.stringify(next);
    if (key === this.lastTrackKey) return;

    this.lastTrackKey = key;
    this.enqueue("setTrack", () => this.service.setTrack(next));
  }

  /**
   * Append a write to the serial queue. A failure is reported and swallowed so
   * one broken update cannot wedge every later one.
   */
  private enqueue(operation: string, task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((error: unknown) => {
      this.reportError(error, operation);
    });
  }

  private reportError(error: unknown, operation: string): void {
    try {
      this.onError(error, operation);
    } catch {
      // Reporting is best-effort; it must not break the queue.
    }
  }
}
