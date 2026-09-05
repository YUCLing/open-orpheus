import { toError } from "../../util";

import type {
  Av3aDecodeExecutor,
  Av3aDecodedFrame,
  Av3aSampleRange,
  Av3aTrackInfo,
} from "./types";

/**
 * Source abstraction over anything that can supply an AV3A-in-M4A file that
 * may still be downloading. `OnlineStreamer` satisfies this interface: the
 * sparse temp file grows in place, `prefixEnd()` reports how many contiguous
 * bytes are readable, and `ensureRange()` downloads a byte range urgently.
 */
export type Av3aM4aSource = {
  /** Absolute path to the (possibly partial) M4A/MP4 file. */
  path: string;
  /** Total expected file size in bytes. */
  totalLength: number;
  /** Contiguous downloaded prefix length starting at byte 0. */
  prefixEnd(): number;
  /** Download `[start, end)` and resolve once the bytes are on disk. */
  ensureRange(start: number, end: number, signal?: AbortSignal): Promise<void>;
};

/** `pts` is the presentation timestamp of the frame in milliseconds. */
export type Av3aPcmFrame = Av3aDecodedFrame & { pts: number };

export type Av3aM4aSessionCallbacks = {
  /** Fired once the `moov` box has been indexed. */
  onOpened?: (info: Av3aTrackInfo) => void;
  /** Fired for every decoded frame. */
  onPcm?: (frame: Av3aPcmFrame) => void;
  /** Fired when the last frame of the track has been decoded. */
  onDone?: () => void;
  /** Fired on a fatal error (e.g. the file has no AV3A track). */
  onError?: (error: Error) => void;
};

/** AVS3-P3 decodes 1024 samples per channel per frame. */
const SAMPLES_PER_CHANNEL = 1024;

const OPEN_RETRY_DELAY_MS = 150;
/** Probe this many tail bytes for a non-faststart `moov` box. */
const TAIL_PROBE_BYTES = 2 * 1024 * 1024;

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onDone = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onDone);
      resolve();
    };
    const timer = setTimeout(onDone, ms);
    signal.addEventListener("abort", onDone, { once: true });
  });
}

/**
 * Drives an [`Av3aDecodeExecutor`] against a progressively downloaded M4A file.
 *
 * Decoding starts as early as possible:
 * 1. The decoder is opened (retried) as soon as the `moov` box is readable;
 *    if the prefix stops growing, the tail is probed in case `moov` sits at
 *    the end of the file.
 * 2. Before each frame is decoded, the session ensures the bytes that sample
 *    needs are on disk (`nextSampleRange` + `ensureRange`), so a sparse temp
 *    file is never read through its zero-filled holes. It only asks the source
 *    when the frame reaches past the source's known contiguous prefix, so
 *    steady-state decode never round-trips the data owner.
 *
 * PCM frames are delivered through `onPcm`; a consumer that cannot keep up can
 * call [`pause`] (decode stops at the next frame boundary) and [`resume`].
 */
export class Av3aM4aSession {
  private readonly abortController = new AbortController();
  private running = false;
  private runPromise: Promise<void> | null = null;
  /** Track info from the last successful open (reused when restarting). */
  private info: Av3aTrackInfo | null = null;
  private paused = false;
  private resumeWaiter: (() => void) | null = null;
  /** Absolute frame index to reposition to on the next decode-loop pass. */
  private pendingSeekFrame: number | null = null;

  constructor(
    private readonly executor: Av3aDecodeExecutor,
    private readonly source: Av3aM4aSource,
    private readonly callbacks: Av3aM4aSessionCallbacks = {}
  ) {}

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Pause after the current frame; no-op when already paused or idle. */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
  }

  /** Resume decoding. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    const waiter = this.resumeWaiter;
    this.resumeWaiter = null;
    waiter?.();
  }

  /**
   * Reposition the decode to an absolute track frame index. Applied on the
   * next decode-loop iteration; also unblocks a paused session so the request
   * is processed promptly.
   */
  seekToFrame(frameIndex: number): void {
    this.pendingSeekFrame = Math.max(0, Math.floor(frameIndex));
    this.resume();
  }

  /** Abort the session. The worker is closed by `run()`'s cleanup. */
  destroy(): void {
    this.abortController.abort(new Error("av3a session destroyed"));
    this.resume();
  }

  /** Run the decode loop until the track ends, is aborted, or fails. */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.runPromise = this.runLoop();
    try {
      await this.runPromise;
    } finally {
      this.running = false;
      this.runPromise = null;
    }
  }

  /**
   * Restart decoding from an absolute track frame after a previous run already
   * finished (e.g. the user seeks after the track ended). The decoder is
   * reopened (runs close it when they finish) and decoding resumes at
   * `frameIndex` without re-emitting `onOpened`.
   */
  async runFrom(frameIndex: number): Promise<void> {
    const target = Math.max(0, Math.floor(frameIndex));
    if (this.running) {
      // A run is in progress: reposition it like a normal seek.
      this.pendingSeekFrame = target;
      this.resume();
      return;
    }
    this.pendingSeekFrame = target;
    const info = this.info;
    if (!info) {
      // Nothing was ever opened successfully; run the normal open+decode flow.
      await this.run();
      return;
    }
    this.running = true;
    this.runPromise = this.restartLoop(info);
    try {
      await this.runPromise;
    } finally {
      this.running = false;
      this.runPromise = null;
    }
  }

  /** Decode again from `info` starting at `pendingSeekFrame` (already set). */
  private async restartLoop(info: Av3aTrackInfo): Promise<void> {
    const signal = this.signal;
    try {
      // The previous run closed the decoder at EOF; reopen before decoding.
      await this.executor.open(this.source.path);
      await this.decodeLoop(info, signal);
      if (!signal.aborted) {
        this.callbacks.onDone?.();
      }
    } catch (error) {
      if (signal.aborted) return;
      this.callbacks.onError?.(toError(error));
    } finally {
      await this.executor.close().catch(() => {});
    }
  }

  /**
   * Abort the session and wait until the decode worker has fully stopped, so
   * callers can safely release the underlying file afterwards.
   */
  async close(): Promise<void> {
    this.destroy();
    await this.runPromise?.catch(() => {});
  }

  private async runLoop(): Promise<void> {
    const signal = this.signal;
    try {
      const info = await this.openUntilReady(signal);
      if (!info || signal.aborted) return;
      this.info = info;
      this.callbacks.onOpened?.(info);
      await this.decodeLoop(info, signal);
      if (!signal.aborted) {
        this.callbacks.onDone?.();
      }
    } catch (error) {
      if (signal.aborted) return;
      this.callbacks.onError?.(toError(error));
    } finally {
      // Best-effort; decode errors already surfaced through onError.
      await this.executor.close().catch(() => {});
    }
  }

  /**
   * Retry `open` until the `moov` box is readable. For non-faststart files the
   * `moov` sits at the end: once the sequential prefix stops advancing, probe
   * the tail instead of waiting for the whole file to download.
   */
  private async openUntilReady(
    signal: AbortSignal
  ): Promise<Av3aTrackInfo | null> {
    let lastPrefix = -1;
    for (;;) {
      if (signal.aborted) return null;
      try {
        await this.executor.open(this.source.path);
        const info = await this.executor.info();
        if (!info || info.frameCount <= 0) {
          throw new Error("AV3A track has no samples");
        }
        return info;
      } catch (error) {
        if (signal.aborted) return null;

        const prefix = this.source.prefixEnd();
        if (prefix >= this.source.totalLength) {
          // Fully downloaded but still not indexable -> not an AV3A M4A file.
          throw toError(error);
        }

        // If the prefix is not advancing, the `moov` box is probably at the
        // end of the file; fetch the tail so open can succeed early.
        if (prefix === lastPrefix) {
          const probeStart = Math.max(
            0,
            this.source.totalLength - TAIL_PROBE_BYTES
          );
          await this.source.ensureRange(
            probeStart,
            this.source.totalLength,
            signal
          );
          if (signal.aborted) return null;
        }
        lastPrefix = prefix;
        await delay(OPEN_RETRY_DELAY_MS, signal);
      }
    }
  }

  private async decodeLoop(
    info: Av3aTrackInfo,
    signal: AbortSignal
  ): Promise<void> {
    for (;;) {
      if (signal.aborted) return;
      await this.waitIfPaused();

      const seekTo = this.pendingSeekFrame;
      if (seekTo !== null) {
        this.pendingSeekFrame = null;
        try {
          await this.executor.seekToFrame(seekTo);
          // The decoder fast-forwards through warm-up frames in one read; make
          // sure their bytes (not just the returned frame's) are downloaded so
          // it never reads through zero-filled holes of a partial file.
          const window = await this.executor.decodeWindowRange();
          if (!window.done && window.end > this.source.prefixEnd()) {
            await this.source.ensureRange(window.start, window.end, signal);
          }
        } catch (error) {
          if (signal.aborted) return;
          throw error;
        }
      }

      let range: Av3aSampleRange;
      try {
        range = await this.executor.nextSampleRange();
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      if (range.done || signal.aborted) return;

      // Only ask the data owner for bytes when the decoder needs something
      // beyond the contiguous prefix we already know about. As long as enough
      // of the file is buffered, decoding never round-trips to the owner,
      // which keeps playback alive while the owner is busy (e.g. a window
      // drag blocking the main process).
      if (range.end > this.source.prefixEnd()) {
        await this.source.ensureRange(range.start, range.end, signal);
        if (signal.aborted) return;
      }
      await this.waitIfPaused();

      const frame = await this.executor.decodeNext();
      if (signal.aborted) return;
      if (frame.done) {
        return;
      }

      const sampleRate = frame.sampleRate || info.sampleRate || 48_000;
      const pts = (frame.frameIndex * SAMPLES_PER_CHANNEL * 1000) / sampleRate;
      this.callbacks.onPcm?.({ ...frame, pts });
    }
  }

  private async waitIfPaused(): Promise<void> {
    if (!this.paused) return;
    await new Promise<void>((resolve) => {
      this.resumeWaiter = resolve;
    });
  }
}
