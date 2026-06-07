import { mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";

import Emittery from "emittery";

import { toError } from "../../util";
import { client } from "../request";

import ChunkTracker from "./ChunkTracker";
import DownloadScheduler from "./DownloadScheduler";
import StorageManager from "./StorageManager";

export type OnlineStreamerEvents = {
  progress: { loaded: number; total: number };
  complete: undefined;
  error: Error;
};

export interface StreamerOptions {
  toleranceThreshold?: number;
}

type SourceMetadata = {
  totalLength: number;
  mimeType: string;
};

type RequestRange = {
  start: number;
  end: number;
};

const DEFAULT_TOLERANCE_THRESHOLD = 512 * 1024;
const DEFAULT_MIME_TYPE = "application/octet-stream";

export class OnlineStreamer extends Emittery<OnlineStreamerEvents> {
  public static tempDir = join(tmpdir(), "onlinestreamer");
  private static readonly activeTempFiles = new Set<string>();

  public readonly url: string;
  public readonly tempFilePath: string;
  public totalLength = 0;

  private readonly tracker = new ChunkTracker();
  private readonly storage: StorageManager;
  private readonly scheduler: DownloadScheduler;
  private readonly metaAbortController = new AbortController();
  private readonly metaReadyPromise: Promise<void>;
  private readonly emittedErrors = new WeakSet<Error>();
  private mimeType = DEFAULT_MIME_TYPE;
  private _destroyed = false;

  get destroyed(): boolean {
    return this._destroyed;
  }

  static async cleanup() {
    await mkdir(OnlineStreamer.tempDir, { recursive: true });

    const entries = await readdir(OnlineStreamer.tempDir);
    await Promise.all(
      entries.map(async (entry) => {
        const filePath = join(OnlineStreamer.tempDir, entry);
        if (OnlineStreamer.activeTempFiles.has(filePath)) return;

        await rm(filePath, { recursive: true, force: true });
      })
    );
  }

  constructor(url: string, options: StreamerOptions = {}) {
    super();

    this.url = url;
    this.tempFilePath = join(
      OnlineStreamer.tempDir,
      `${process.pid}-${randomUUID()}.audio`
    );
    OnlineStreamer.activeTempFiles.add(this.tempFilePath);
    this.storage = new StorageManager(this.tempFilePath);
    this.scheduler = new DownloadScheduler({
      url,
      toleranceThreshold:
        options.toleranceThreshold ?? DEFAULT_TOLERANCE_THRESHOLD,
      tracker: this.tracker,
      storage: this.storage,
      getTotalLength: () => this.totalLength,
      onProgress: () => this.emitProgress(),
      onComplete: () => this.emitComplete(),
      onError: (error) => this.emitError(error),
    });

    this.metaReadyPromise = this.prepare();
    this.metaReadyPromise.catch((error: unknown) =>
      this.emitError(toError(error))
    );
  }

  async handleRequest(request: Request) {
    try {
      await this.metaReadyPromise;
      if (this._destroyed) {
        return new Response("OnlineStreamer has been destroyed", {
          status: 410,
        });
      }

      const rangeHeader = request.headers.get("range");
      const isRangeRequest = rangeHeader !== null;
      const { start: reqStart, end: reqEnd } = parseRequestRange(
        rangeHeader,
        this.totalLength
      );
      const chunkLength = reqEnd - reqStart;
      const session = this.scheduler.createUrgentSession(request.signal);
      const iterator = this.scheduler.streamUrgent(
        reqStart,
        reqEnd,
        session.signal
      );
      const body = asyncIteratorToReadableStream(iterator, {
        onCancel: session.abort,
        onClose: session.close,
      });
      const headers = new Headers({
        "Accept-Ranges": "bytes",
        "Content-Type": this.mimeType,
        "Content-Length": chunkLength.toString(),
      });

      if (isRangeRequest) {
        headers.set(
          "Content-Range",
          `bytes ${reqStart}-${reqEnd - 1}/${this.totalLength}`
        );
      }

      return new Response(body, {
        status: isRangeRequest ? 206 : 200,
        headers,
      });
    } catch (error) {
      if (error instanceof RangeNotSatisfiableError) {
        return new Response("Range Not Satisfiable", {
          status: 416,
          headers: {
            "Accept-Ranges": "bytes",
            "Content-Range": `bytes */${this.totalLength}`,
          },
        });
      }

      const normalizedError = toError(error);
      this.emitError(normalizedError);
      return new Response(normalizedError.message, { status: 500 });
    }
  }

  getDownloadedIntervals() {
    this.assertNotDestroyed();
    return this.tracker.getIntervals();
  }

  async readBuffer(start?: number, end?: number) {
    this.assertNotDestroyed();
    await this.metaReadyPromise;
    this.assertNotDestroyed();

    const range = this.normalizeReadRange(start, end);
    return this.storage.readBuffer(range.start, range.end);
  }

  createReadStream(start?: number, end?: number) {
    this.assertNotDestroyed();
    return Readable.from(this.createReadStreamIterator(start, end));
  }

  async destroy() {
    if (this._destroyed) return;

    this._destroyed = true;
    this.metaAbortController.abort(new Error("OnlineStreamer destroyed"));
    this.scheduler.destroy();

    try {
      await this.storage.delete();
    } finally {
      OnlineStreamer.activeTempFiles.delete(this.tempFilePath);
    }
  }

  private async prepare() {
    await mkdir(OnlineStreamer.tempDir, { recursive: true });
    await this.storage.open();

    const metadata = await this.fetchMetadata();
    this.totalLength = metadata.totalLength;
    this.mimeType = metadata.mimeType;

    await this.storage.setLength(this.totalLength);
    this.scheduler.startBackground();
  }

  private async fetchMetadata(): Promise<SourceMetadata> {
    const headMetadata = await this.fetchHeadMetadata().catch(() => null);
    if (headMetadata) return headMetadata;

    return this.fetchRangeMetadata();
  }

  private async fetchHeadMetadata(): Promise<SourceMetadata | null> {
    const response = await client(this.url, {
      method: "HEAD",
      throwHttpErrors: false,
      signal: this.metaAbortController.signal,
    });

    if (response.statusCode < 200 || response.statusCode >= 400) {
      return null;
    }

    const totalLength = parseContentLength(response.headers["content-length"]);
    if (!totalLength) return null;

    return {
      totalLength,
      mimeType:
        firstHeaderValue(response.headers["content-type"]) ?? DEFAULT_MIME_TYPE,
    };
  }

  private fetchRangeMetadata(): Promise<SourceMetadata> {
    return new Promise((resolve, reject) => {
      const request = client.stream(this.url, {
        headers: {
          Range: "bytes=0-0",
        },
        retry: { limit: 0 },
        throwHttpErrors: false,
      });

      let settled = false;
      const abortRequest = () => {
        if (settled) return;
        settled = true;
        request.destroy(toError(this.metaAbortController.signal.reason));
        reject(toError(this.metaAbortController.signal.reason));
      };

      this.metaAbortController.signal.addEventListener("abort", abortRequest, {
        once: true,
      });

      request.once("response", (response) => {
        if (settled) return;

        const totalLength =
          parseContentRangeTotal(response.headers["content-range"]) ??
          parseContentLength(response.headers["content-length"]);

        if (response.statusCode < 200 || response.statusCode >= 400) {
          settled = true;
          reject(
            new Error(`Failed to read source metadata: ${response.statusCode}`)
          );
          request.destroy();
          return;
        }

        if (!totalLength) {
          settled = true;
          reject(new Error("Remote source did not provide a content length"));
          request.destroy();
          return;
        }

        settled = true;
        resolve({
          totalLength,
          mimeType:
            firstHeaderValue(response.headers["content-type"]) ??
            DEFAULT_MIME_TYPE,
        });
        request.destroy();
      });

      request.once("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
  }

  private normalizeReadRange(start?: number, end?: number) {
    const normalizedStart = normalizeBoundary(start ?? 0);
    const normalizedEnd = normalizeBoundary(end ?? this.totalLength);

    if (normalizedStart > normalizedEnd) {
      throw new RangeError("Start must be less than or equal to end");
    }

    return {
      start: clamp(normalizedStart, 0, this.totalLength),
      end: clamp(normalizedEnd, 0, this.totalLength),
    };
  }

  private async *createReadStreamIterator(start?: number, end?: number) {
    this.assertNotDestroyed();
    await this.metaReadyPromise;
    this.assertNotDestroyed();

    const range = this.normalizeReadRange(start, end);
    yield* this.storage.readRange(range.start, range.end);
  }

  private assertNotDestroyed() {
    if (this._destroyed) {
      throw new Error("OnlineStreamer has been destroyed");
    }
  }

  private emitProgress() {
    if (this._destroyed) return;
    void this.emit("progress", {
      loaded: this.tracker.loadedBytes,
      total: this.totalLength,
    }).catch((error: unknown) => console.error(error));
  }

  private emitComplete() {
    if (this._destroyed) return;
    void this.emit("complete").catch((error: unknown) => console.error(error));
  }

  private emitError(error: Error) {
    if (this._destroyed) return;
    if (this.emittedErrors.has(error)) return;

    this.emittedErrors.add(error);
    void this.emit("error", error).catch((emitError: unknown) =>
      console.error(emitError)
    );
  }
}

export default OnlineStreamer;

class RangeNotSatisfiableError extends Error {}

function parseRequestRange(rangeHeader: string | null, totalLength: number) {
  if (!rangeHeader) return { start: 0, end: totalLength };

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) throw new RangeNotSatisfiableError();

  const [, startText, endText] = match;
  if (!startText && !endText) throw new RangeNotSatisfiableError();

  let start: number;
  let end: number;

  if (!startText) {
    const suffixLength = Number.parseInt(endText, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      throw new RangeNotSatisfiableError();
    }
    start = Math.max(0, totalLength - suffixLength);
    end = totalLength;
  } else {
    start = Number.parseInt(startText, 10);
    const parsedEnd = endText ? Number.parseInt(endText, 10) + 1 : undefined;
    end = parsedEnd ?? totalLength;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new RangeNotSatisfiableError();
  }

  start = normalizeBoundary(start);
  end = normalizeBoundary(end);

  if (start >= totalLength || end <= start) {
    throw new RangeNotSatisfiableError();
  }

  return {
    start,
    end: Math.min(end, totalLength),
  } satisfies RequestRange;
}

function asyncIteratorToReadableStream(
  iterator: AsyncIterator<Buffer>,
  hooks: {
    onCancel: (reason?: unknown) => void;
    onClose: () => void;
  }
) {
  let closed = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          closed = true;
          hooks.onClose();
          controller.close();
          return;
        }

        controller.enqueue(next.value);
      } catch (error) {
        closed = true;
        hooks.onClose();
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (closed) return;
      closed = true;
      hooks.onCancel(reason);
      await iterator.return?.();
      hooks.onClose();
    },
  });
}

function parseContentLength(value: string | string[] | undefined) {
  const text = firstHeaderValue(value);
  if (!text) return null;

  const length = Number.parseInt(text, 10);
  return Number.isFinite(length) && length > 0 ? length : null;
}

function parseContentRangeTotal(value: string | string[] | undefined) {
  const text = firstHeaderValue(value);
  const match = text?.match(/\/(\d+)$/);
  if (!match) return null;

  const length = Number.parseInt(match[1], 10);
  return Number.isFinite(length) && length > 0 ? length : null;
}

function firstHeaderValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function normalizeBoundary(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
