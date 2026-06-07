import { toError } from "../../util";
import { client } from "../request";

import type ChunkTracker from "./ChunkTracker";
import type StorageManager from "./StorageManager";

type GotStream = ReturnType<typeof client.stream>;

const BACKGROUND_RETRY_MIN_DELAY = 1000;
const BACKGROUND_RETRY_MAX_DELAY = 15_000;

type HttpStatusError = Error & {
  statusCode?: number;
};

type Range = {
  start: number;
  end: number;
};

type ActiveUrgentRange = Range & {
  signal: AbortSignal;
};

type BackgroundGapResult =
  | { type: "gap"; gap: Range }
  | { type: "blocked"; version: number }
  | { type: "complete" };

type DownloadSchedulerOptions = {
  url: string;
  toleranceThreshold: number;
  tracker: ChunkTracker;
  storage: StorageManager;
  getTotalLength: () => number;
  onProgress: () => void;
  onComplete: () => void;
  onError: (error: Error) => void;
};

export type UrgentSession = {
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
  close: () => void;
};

export default class DownloadScheduler {
  private readonly url: string;
  private readonly toleranceThreshold: number;
  private readonly tracker: ChunkTracker;
  private readonly storage: StorageManager;
  private readonly getTotalLength: () => number;
  private readonly onProgress: () => void;
  private readonly onComplete: () => void;
  private readonly onError: (error: Error) => void;

  private readonly activeRequests = new Set<GotStream>();
  private readonly backgroundController = new AbortController();
  private urgentController: AbortController | null = null;
  private backgroundStarted = false;
  private destroyed = false;
  private completeEmitted = false;
  private writeChain: Promise<void> = Promise.resolve();
  private activeUrgentRange: ActiveUrgentRange | null = null;
  private urgentRangeVersion = 0;
  private backgroundRetryDelay = BACKGROUND_RETRY_MIN_DELAY;
  private readonly urgentRangeWaiters = new Set<() => void>();

  constructor(options: DownloadSchedulerOptions) {
    this.url = options.url;
    this.toleranceThreshold = Math.max(0, options.toleranceThreshold);
    this.tracker = options.tracker;
    this.storage = options.storage;
    this.getTotalLength = options.getTotalLength;
    this.onProgress = options.onProgress;
    this.onComplete = options.onComplete;
    this.onError = options.onError;
  }

  startBackground() {
    if (this.backgroundStarted) return;
    this.backgroundStarted = true;
    this.runBackground().catch((error: unknown) => {
      if (this.destroyed || this.backgroundController.signal.aborted) return;
      this.onError(toError(error));
    });
  }

  createUrgentSession(signal?: AbortSignal): UrgentSession {
    this.urgentController?.abort(new Error("Superseded by a newer range"));

    const controller = new AbortController();
    const abortFromSignal = () => controller.abort(signal?.reason);

    if (signal?.aborted) {
      abortFromSignal();
    } else {
      signal?.addEventListener("abort", abortFromSignal, { once: true });
    }

    this.urgentController = controller;

    return {
      signal: controller.signal,
      abort: (reason?: unknown) => controller.abort(reason),
      close: () => {
        signal?.removeEventListener("abort", abortFromSignal);
        if (this.urgentController === controller) {
          this.urgentController = null;
        }
      },
    };
  }

  async *streamUrgent(start: number, end: number, signal: AbortSignal) {
    let cursor = start;

    while (cursor < end) {
      if (signal.aborted || this.destroyed) return;

      const hitEnd = this.tracker.getDownloadedEnd(cursor, end);
      if (hitEnd > cursor) {
        for await (const chunk of this.storage.readRange(cursor, hitEnd)) {
          if (signal.aborted || this.destroyed) return;
          yield chunk;
        }
        cursor = hitEnd;
        continue;
      }

      const missEnd = this.tracker.getGapEnd(cursor, end);
      let received = 0;
      const urgentRange: ActiveUrgentRange = {
        start: cursor,
        end: this.getUrgentReservedEnd(cursor, missEnd),
        signal,
      };
      this.activeUrgentRange = urgentRange;
      this.notifyUrgentRangeChanged();

      try {
        for await (const chunk of this.downloadRange(
          cursor,
          missEnd,
          "urgent",
          signal
        )) {
          received += chunk.byteLength;
          cursor += chunk.byteLength;
          urgentRange.start = cursor;
          urgentRange.end = this.getUrgentReservedEnd(cursor, missEnd);
          this.notifyUrgentRangeChanged();
          yield chunk;
        }
      } catch (error) {
        if (signal.aborted || this.destroyed) return;
        this.onError(toError(error));
        throw error;
      } finally {
        if (this.activeUrgentRange === urgentRange) {
          this.activeUrgentRange = null;
          this.notifyUrgentRangeChanged();
        }
      }

      if (signal.aborted || this.destroyed) return;

      if (
        received === 0 &&
        this.tracker.getDownloadedEnd(cursor, end) === cursor
      ) {
        throw new Error(
          "Remote stream ended before the requested range was filled"
        );
      }
    }
  }

  destroy() {
    this.destroyed = true;
    this.backgroundController.abort(new Error("OnlineStreamer destroyed"));
    this.urgentController?.abort(new Error("OnlineStreamer destroyed"));
    this.urgentController = null;

    for (const request of this.activeRequests) {
      request.destroy();
    }

    this.activeRequests.clear();
  }

  private async runBackground() {
    while (!this.destroyed && !this.backgroundController.signal.aborted) {
      const totalLength = this.getTotalLength();
      const gapResult = this.findBackgroundGap(totalLength);

      if (gapResult.type === "complete") {
        this.emitCompleteIfNeeded();
        return;
      }

      if (gapResult.type === "blocked") {
        await this.waitForUrgentRangeChange(
          this.backgroundController.signal,
          gapResult.version
        );
        continue;
      }

      const { gap } = gapResult;
      try {
        for await (const chunk of this.downloadRange(
          gap.start,
          gap.end,
          "background",
          this.backgroundController.signal
        )) {
          void chunk;
          // The background worker only persists bytes and updates the tracker.
        }
        this.backgroundRetryDelay = BACKGROUND_RETRY_MIN_DELAY;
      } catch (error) {
        if (this.destroyed || this.backgroundController.signal.aborted) return;

        const normalizedError = toError(error);
        this.onError(normalizedError);

        if (isFatalBackgroundError(normalizedError)) return;

        await delay(
          this.backgroundRetryDelay,
          this.backgroundController.signal
        );
        this.backgroundRetryDelay = Math.min(
          this.backgroundRetryDelay * 2,
          BACKGROUND_RETRY_MAX_DELAY
        );
      }
    }
  }

  private findBackgroundGap(totalLength: number): BackgroundGapResult {
    const gaps = this.tracker.getMissingIntervals(0, totalLength);
    if (gaps.length === 0) return { type: "complete" };

    const activeUrgentRange = this.activeUrgentRange;
    if (
      !activeUrgentRange ||
      activeUrgentRange.signal.aborted ||
      activeUrgentRange.end <= activeUrgentRange.start
    ) {
      return { type: "gap", gap: gaps[0] };
    }

    for (const gap of gaps) {
      if (
        gap.end <= activeUrgentRange.start ||
        gap.start >= activeUrgentRange.end
      ) {
        return { type: "gap", gap };
      }

      if (activeUrgentRange.end < gap.end) {
        return {
          type: "gap",
          gap: { start: activeUrgentRange.end, end: gap.end },
        };
      }

      if (gap.start < activeUrgentRange.start) {
        return {
          type: "gap",
          gap: { start: gap.start, end: activeUrgentRange.start },
        };
      }
    }

    return { type: "blocked", version: this.urgentRangeVersion };
  }

  private getUrgentReservedEnd(start: number, limit: number) {
    return Math.min(limit, start + Math.max(1, this.toleranceThreshold));
  }

  private waitForUrgentRangeChange(signal: AbortSignal, version: number) {
    if (signal.aborted || this.urgentRangeVersion !== version) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const done = () => {
        signal.removeEventListener("abort", done);
        this.urgentRangeWaiters.delete(done);
        resolve();
      };

      this.urgentRangeWaiters.add(done);
      signal.addEventListener("abort", done, { once: true });

      if (this.urgentRangeVersion !== version) {
        done();
      }
    });
  }

  private notifyUrgentRangeChanged() {
    this.urgentRangeVersion += 1;

    for (const waiter of this.urgentRangeWaiters) {
      waiter();
    }
  }

  private async *downloadRange(
    start: number,
    end: number,
    mode: "background" | "urgent",
    signal: AbortSignal
  ) {
    if (end <= start || signal.aborted || this.destroyed) return;

    let offset = start;
    let stopReason: "abort" | "collision" | null = null;
    const request = client.stream(this.url, {
      headers: {
        Range: `bytes=${start}-${end - 1}`,
      },
      retry: { limit: 0 },
      throwHttpErrors: false,
    });

    const abortRequest = () => {
      stopReason = "abort";
      request.destroy(toError(signal.reason ?? "Request aborted"));
    };

    signal.addEventListener("abort", abortRequest, { once: true });
    this.activeRequests.add(request);

    try {
      await this.waitForRangeResponse(request, start, end);

      for await (const rawChunk of request) {
        if (signal.aborted || this.destroyed) {
          stopReason = "abort";
          request.destroy();
          return;
        }

        let chunk = Buffer.from(rawChunk as Uint8Array);
        if (offset + chunk.byteLength > end) {
          chunk = chunk.subarray(0, end - offset);
        }

        if (chunk.byteLength === 0) break;

        if (
          mode === "urgent" &&
          this.tracker.getDownloadedEnd(offset, end) > offset
        ) {
          stopReason = "collision";
          request.destroy();
          return;
        }

        const writeResult = await this.checkBeforeWrite(offset, chunk, end);
        if (writeResult === "collision") {
          stopReason = "collision";
          request.destroy();
          return;
        }

        offset += chunk.byteLength;
        if (mode === "urgent") {
          yield chunk;
        }

        if (offset >= end) {
          request.destroy();
          return;
        }
      }
    } catch (error) {
      if (stopReason || signal.aborted || this.destroyed) return;
      throw error;
    } finally {
      signal.removeEventListener("abort", abortRequest);
      this.activeRequests.delete(request);
    }
  }

  private waitForRangeResponse(request: GotStream, start: number, end: number) {
    return new Promise<void>((resolve, reject) => {
      let settled = false;

      request.once("response", (response) => {
        const totalLength = this.getTotalLength();
        const acceptsRange = response.statusCode === 206;
        const acceptsWholeBody =
          response.statusCode === 200 && start === 0 && end === totalLength;

        if (acceptsRange || acceptsWholeBody) {
          settled = true;
          resolve();
          return;
        }

        const error = new Error(
          `Remote source rejected range ${start}-${end - 1}: ${response.statusCode}`
        ) as HttpStatusError;
        error.statusCode = response.statusCode;
        settled = true;
        request.destroy(error);
        reject(error);
      });

      request.once("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
  }

  private async checkBeforeWrite(
    offset: number,
    chunk: Buffer,
    rangeEnd: number
  ) {
    const writeTask = this.writeChain.then(async () => {
      const collisionSpan = this.tracker.getDownloadedSpanFrom(
        offset,
        rangeEnd
      );
      if (collisionSpan > 0 && collisionSpan >= this.toleranceThreshold) {
        return "collision" as const;
      }

      await this.storage.write(offset, chunk);
      const addedBytes = this.tracker.addInterval(
        offset,
        offset + chunk.byteLength
      );

      if (addedBytes > 0) {
        this.onProgress();
        this.emitCompleteIfNeeded();
      }

      return "written" as const;
    });

    this.writeChain = writeTask.then(
      () => {},
      () => {}
    );

    return writeTask;
  }

  private emitCompleteIfNeeded() {
    if (this.completeEmitted) return;
    if (!this.tracker.isComplete(this.getTotalLength())) return;

    this.completeEmitted = true;
    this.onComplete();
  }
}

function isFatalBackgroundError(error: Error) {
  const code = (error as NodeJS.ErrnoException).code;
  const statusCode = (error as HttpStatusError).statusCode;
  return (
    (typeof statusCode === "number" && statusCode >= 400) ||
    code === "ENOSPC" ||
    code === "EACCES" ||
    code === "EROFS" ||
    code === "EMFILE" ||
    code === "ENFILE"
  );
}

function delay(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timeout = setTimeout(done, ms);

    signal.addEventListener("abort", done, { once: true });
  });
}
