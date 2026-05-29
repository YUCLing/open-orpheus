import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

import Emittery from "emittery";
import mime from "mime";

import type { AudioPlayInfo } from "../../preload/Player";
import client from "../request";
import { sleep } from "../../util";

// #region Constants
const CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB chunk limit to prevent lock starvation
const CONSUMER_CHUNK_SIZE = 256 * 1024;
const MAX_FETCH_ATTEMPTS = 3;
const BASE_FETCH_RETRY_DELAY_MS = 250;
const MAX_FETCH_RETRY_DELAY_MS = 2000;
// #endregion

// #region Types
type Interval = [start: number, end: number]; // inclusive [start, end]

interface SongBuffer {
  songId: string;
  playInfo: AudioPlayInfo;
  generation: number;
  url: string;
  totalSize: number;
  buffer: Buffer;
  intervals: Interval[]; // Ranges fully downloaded and written to RAM
  pendingIntervals: Interval[]; // Exact locks for ranges currently being fetched
  backgroundFetchInProgress: boolean;
  contentType: string;
  fetchFailures: Map<string, FetchFailure>;
}

interface ChunkWrittenDetail {
  start: number;
  end: number;
}

interface FetchFailure {
  attempts: number;
  retryAt: number;
  error: unknown;
}

interface OpenedRangeStream {
  stream: Readable;
  headers: IncomingHttpHeaders;
  actualStart: number;
  statusCode: number;
}

interface ParsedRange {
  start: number;
  end?: number;
}

export type AudioStreamerEvents = {
  progress: { playInfo: AudioPlayInfo; buffer: SongBuffer; progress: number };
  complete: { playInfo: AudioPlayInfo; buffer: SongBuffer };

  chunkwritten: ChunkWrittenDetail;
  chunkerror: unknown;
  bufferchange: undefined;
};
// #endregion

// #region Interval helpers
class IntervalMath {
  static merge(intervals: Interval[], added: Interval): void {
    intervals.push(added);
    intervals.sort((a, b) => a[0] - b[0]);

    let write = 0;
    for (let i = 0; i < intervals.length; i++) {
      if (write > 0 && intervals[i][0] <= intervals[write - 1][1] + 1) {
        intervals[write - 1][1] = Math.max(
          intervals[write - 1][1],
          intervals[i][1]
        );
      } else {
        intervals[write++] = intervals[i];
      }
    }
    intervals.length = write;
  }

  static addPending(intervals: Interval[], added: Interval): void {
    intervals.push(added);
    intervals.sort((a, b) => a[0] - b[0]);
  }

  static removePending(intervals: Interval[], removed: Interval): void {
    const index = intervals.findIndex(
      ([s, e]) => s === removed[0] && e === removed[1]
    );
    if (index !== -1) intervals.splice(index, 1);
  }

  static missing(have: Interval[], start: number, end: number): Interval[] {
    const missing: Interval[] = [];
    let cursor = start;

    for (const [s, e] of have) {
      if (s > cursor) missing.push([cursor, Math.min(s - 1, end)]);
      cursor = Math.max(cursor, e + 1);
      if (cursor > end) break;
    }

    if (cursor <= end) missing.push([cursor, end]);
    return missing;
  }

  static trulyMissing(
    requested: Interval,
    have: Interval[],
    pending: Interval[]
  ): Interval[] {
    const missingFromHave = this.missing(have, requested[0], requested[1]);
    const trulyMissing: Interval[] = [];

    for (const [mStart, mEnd] of missingFromHave) {
      trulyMissing.push(...this.missing(pending, mStart, mEnd));
    }

    return trulyMissing;
  }

  static downloadedBytes(intervals: Interval[]): number {
    return intervals.reduce((total, [s, e]) => total + (e - s + 1), 0);
  }
}
// #endregion

// #region Pure helpers
function getHeaderValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function parseSizeFromHeaders(headers: IncomingHttpHeaders): {
  totalSize: number;
  contentType: string;
} {
  const contentType = getHeaderValue(headers["content-type"]) ?? "audio/mpeg";
  const contentRange = getHeaderValue(headers["content-range"]);

  if (contentRange) {
    const match = contentRange.match(/\/(\d+)/);
    if (match) return { totalSize: Number(match[1]), contentType };
  }

  const contentLength = getHeaderValue(headers["content-length"]);
  return {
    totalSize: contentLength ? Number(contentLength) : 0,
    contentType,
  };
}

function parseRangeHeader(rangeHeader: string | null): ParsedRange | null {
  if (!rangeHeader) return { start: 0 };

  const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
  if (!match) return null;

  return {
    start: Number(match[1]),
    end: match[2] ? Number(match[2]) : undefined,
  };
}

function getRangeKey(start: number, end: number): string {
  return `${start}-${end}`;
}

function getFetchDelay(attempts: number): number {
  return Math.min(
    BASE_FETCH_RETRY_DELAY_MS * 2 ** Math.max(0, attempts - 1),
    MAX_FETCH_RETRY_DELAY_MS
  );
}

function getChunkEnd(start: number, end: number): number {
  return Math.min(end, start + CHUNK_SIZE - 1);
}

function getMissingChunks(
  sb: SongBuffer,
  start: number,
  end: number
): Interval[] {
  return IntervalMath.trulyMissing(
    [start, end],
    sb.intervals,
    sb.pendingIntervals
  ).map(([mStart, mEnd]) => [mStart, getChunkEnd(mStart, mEnd)]);
}

function getFirstMissingChunk(
  sb: SongBuffer,
  start: number,
  end: number
): Interval | null {
  return getMissingChunks(sb, start, end)[0] ?? null;
}

function getAvailableEnd(sb: SongBuffer, cursor: number): number {
  for (const [s, e] of sb.intervals) {
    if (cursor >= s && cursor <= e) return e;
  }
  return -1;
}

function hasRange(sb: SongBuffer, start: number, end: number): boolean {
  return getAvailableEnd(sb, start) >= end;
}

function isPending(sb: SongBuffer, cursor: number): boolean {
  return sb.pendingIntervals.some(([s, e]) => cursor >= s && cursor <= e);
}

function getFetchFailure(
  sb: SongBuffer,
  start: number,
  end: number
): FetchFailure | undefined {
  return sb.fetchFailures.get(getRangeKey(start, end));
}

function registerFetchSuccess(
  sb: SongBuffer,
  start: number,
  end: number
): void {
  sb.fetchFailures.delete(getRangeKey(start, end));
}

function registerFetchFailure(
  sb: SongBuffer,
  start: number,
  end: number,
  error: unknown
): void {
  const key = getRangeKey(start, end);
  const attempts = (sb.fetchFailures.get(key)?.attempts ?? 0) + 1;

  sb.fetchFailures.set(key, {
    attempts,
    retryAt: Date.now() + getFetchDelay(attempts),
    error,
  });
}

function canFetchRange(sb: SongBuffer, start: number, end: number): boolean {
  const failure = getFetchFailure(sb, start, end);
  return !failure || failure.attempts < MAX_FETCH_ATTEMPTS;
}

function getRetryDelay(sb: SongBuffer, start: number, end: number): number {
  const failure = getFetchFailure(sb, start, end);
  if (!failure) return 0;
  return Math.max(0, failure.retryAt - Date.now());
}

function createCachedSlice(
  sb: SongBuffer,
  start: number,
  end: number
): Uint8Array {
  return new Uint8Array(
    sb.buffer.buffer,
    sb.buffer.byteOffset + start,
    end - start + 1
  );
}

function createNodeWebStream(nodeStream: ReturnType<typeof createReadStream>) {
  return new ReadableStream({
    start(controller) {
      nodeStream.on("data", (chunk) => controller.enqueue(chunk));
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
    cancel() {
      nodeStream.destroy();
    },
  });
}
// #endregion

// #region Upstream HTTP helpers
async function openRangeStream(
  url: string,
  start: number,
  end?: number
): Promise<OpenedRangeStream> {
  const rangeValue =
    end !== undefined ? `bytes=${start}-${end}` : `bytes=${start}-`;

  const stream = client.stream(url, {
    headers: { Range: rangeValue },
    throwHttpErrors: false,
  }) as unknown as Readable;

  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    stream.once("response", (res: IncomingMessage) => resolve(res));
    stream.once("error", reject);
  });

  if (response.statusCode && response.statusCode >= 400) {
    stream.destroy();
    throw new Error(`Upstream HTTP Error: ${response.statusCode}`);
  }

  let actualStart = start;
  if (response.statusCode === 206) {
    const contentRange = response.headers["content-range"];
    if (typeof contentRange === "string") {
      const match = contentRange.match(/bytes\s+(\d+)-/i);
      if (match) actualStart = Number(match[1]);
    }
  } else if (response.statusCode === 200) {
    actualStart = 0;
  }

  return {
    stream,
    headers: response.headers,
    actualStart,
    statusCode: response.statusCode ?? 0,
  };
}
// #endregion

export default class AudioStreamer extends Emittery<AudioStreamerEvents> {
  // #region State
  private songBuffer: SongBuffer | null = null;
  private currentAudioPlayInfo: AudioPlayInfo | null = null;
  private playInfoGeneration = 0;
  // #endregion

  // #region Accessors
  get buffer() {
    return this.songBuffer;
  }

  get audioPlayInfo() {
    return this.currentAudioPlayInfo;
  }
  // #endregion

  // #region Playback lifecycle
  setPlayInfo(playInfo: AudioPlayInfo | null): void {
    this.playInfoGeneration++;
    this.currentAudioPlayInfo = playInfo;

    if (this.songBuffer) {
      this.songBuffer = null;
      this.notifyFetchError(new Error("Audio play info changed"));
      this.notifyBufferChanged();
    }
  }

  private isCurrentGeneration(generation: number, songId: string): boolean {
    return (
      this.playInfoGeneration === generation &&
      this.currentAudioPlayInfo?.songId === songId
    );
  }
  // #endregion

  // #region Event helpers
  private notifyFetchError(error: unknown): void {
    void this.emit("chunkerror", error);
  }

  private notifyBufferChanged(): void {
    void this.emit("bufferchange");
  }

  private onProgress(sb: SongBuffer, progress: number): void {
    if (this.songBuffer !== sb) return;
    void this.emit("progress", {
      playInfo: sb.playInfo,
      buffer: sb,
      progress,
    });
  }

  private onComplete(sb: SongBuffer): void {
    if (this.songBuffer !== sb) return;
    void this.emit("complete", {
      playInfo: sb.playInfo,
      buffer: sb,
    });
  }

  private waitForData(
    sb: SongBuffer,
    signal: AbortSignal,
    timeoutMs?: number
  ): Promise<void> {
    if (this.songBuffer !== sb) return Promise.resolve();
    if (timeoutMs !== undefined && timeoutMs <= 0) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      let retryTimer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (retryTimer) clearTimeout(retryTimer);
        this.off("chunkwritten", onWakeup);
        this.off("chunkerror", onWakeup);
        this.off("bufferchange", onWakeup);
        signal.removeEventListener("abort", onAbort);
      };

      const onWakeup = () => {
        cleanup();
        resolve();
      };

      const onAbort = () => {
        cleanup();
        reject(new Error("Stream cancelled by browser"));
      };

      this.on("chunkwritten", onWakeup);
      this.on("chunkerror", onWakeup);
      this.on("bufferchange", onWakeup);
      signal.addEventListener("abort", onAbort, { once: true });

      if (timeoutMs !== undefined) retryTimer = setTimeout(onWakeup, timeoutMs);
      if (signal.aborted) onAbort();
      if (this.songBuffer !== sb) onWakeup();
    });
  }
  // #endregion

  // #region Buffer lifecycle
  private ensureSongBuffer(
    songId: string,
    playInfo: AudioPlayInfo,
    generation: number,
    url: string,
    totalSize: number,
    contentType: string
  ): SongBuffer {
    if (
      this.songBuffer?.songId === songId &&
      this.songBuffer.generation === generation
    )
      return this.songBuffer;

    this.songBuffer = {
      songId,
      playInfo,
      generation,
      url,
      totalSize,
      buffer: Buffer.allocUnsafe(totalSize),
      intervals: [],
      pendingIntervals: [],
      backgroundFetchInProgress: false,
      contentType,
      fetchFailures: new Map(),
    };

    return this.songBuffer;
  }

  private startMissingFetches(
    sb: SongBuffer,
    start: number,
    end: number,
    initialStreamData: OpenedRangeStream | null = null
  ): OpenedRangeStream | null {
    let reusableStream = initialStreamData;

    for (const [mStart, chunkEnd] of getMissingChunks(sb, start, end)) {
      if (reusableStream && mStart === start) {
        void this.fetchAndCache(sb, mStart, chunkEnd, reusableStream);
        reusableStream = null;
      } else {
        void this.fetchAndCache(sb, mStart, chunkEnd);
      }
    }

    return reusableStream;
  }
  // #endregion

  // #region Producers
  private async fetchAndCache(
    sb: SongBuffer,
    start: number,
    end: number,
    preOpenedStream?: OpenedRangeStream
  ): Promise<boolean> {
    if (this.songBuffer !== sb) return false;
    if (!canFetchRange(sb, start, end)) return false;
    if (getRetryDelay(sb, start, end) > 0) return false;

    IntervalMath.addPending(sb.pendingIntervals, [start, end]);
    let wroteBytes = false;

    try {
      const { stream, actualStart, statusCode } =
        preOpenedStream ?? (await openRangeStream(sb.url, start, end));

      if (this.songBuffer !== sb) {
        stream.destroy();
        return false;
      }

      if (statusCode === 200 && start > 0) {
        stream.destroy();
        throw new Error("Upstream ignored range request for non-zero start");
      }

      if (statusCode === 206 && actualStart !== start) {
        stream.destroy();
        throw new Error(
          `Unexpected upstream content range start: ${actualStart}, expected ${start}`
        );
      }

      let offset = actualStart;

      for await (const value of stream) {
        if (this.songBuffer !== sb) {
          stream.destroy();
          return false;
        }

        const chunk = Buffer.isBuffer(value) ? value : (value as Uint8Array);
        if (offset > end || offset >= sb.totalSize) {
          stream.destroy();
          break;
        }

        const writableLength = Math.min(
          chunk.byteLength,
          end - offset + 1,
          sb.totalSize - offset
        );
        if (writableLength <= 0) {
          stream.destroy();
          break;
        }

        sb.buffer.set(chunk.subarray(0, writableLength), offset);
        wroteBytes = true;

        const chunkStart = offset;
        const chunkEnd = offset + writableLength - 1;

        IntervalMath.merge(sb.intervals, [chunkStart, chunkEnd]);
        offset += writableLength;

        void this.emit("chunkwritten", { start: chunkStart, end: chunkEnd });
        this.onProgress(
          sb,
          IntervalMath.downloadedBytes(sb.intervals) / sb.totalSize
        );

        if (offset > end) {
          stream.destroy();
          break;
        }
      }

      if (this.songBuffer === sb && !hasRange(sb, start, end)) {
        throw new Error(
          `Upstream ended before requested range was cached: ${start}-${end}`
        );
      }

      registerFetchSuccess(sb, start, end);

      if (IntervalMath.downloadedBytes(sb.intervals) >= sb.totalSize) {
        this.onComplete(sb);
      }

      return true;
    } catch (e) {
      registerFetchFailure(sb, start, end, e);
      this.notifyFetchError(e);
      return false;
    } finally {
      IntervalMath.removePending(sb.pendingIntervals, [start, end]);
      if (!wroteBytes) this.notifyBufferChanged();
    }
  }

  private async fetchNextBackgroundChunk(sb: SongBuffer): Promise<boolean> {
    const target = getFirstMissingChunk(sb, 0, sb.totalSize - 1);
    if (!target) return false;

    const [start, end] = target;
    const success = await this.fetchAndCache(sb, start, end);
    if (success) return true;
    if (this.songBuffer !== sb) return false;

    const failure = getFetchFailure(sb, start, end);
    if (failure?.attempts && failure.attempts >= MAX_FETCH_ATTEMPTS) {
      return false;
    }

    const retryDelay = getRetryDelay(sb, start, end);
    if (retryDelay <= 0) return false;

    await sleep(retryDelay);
    return this.songBuffer === sb;
  }
  // #endregion

  // #region Consumers
  private async waitForMissingConsumerData(
    sb: SongBuffer,
    cursor: number,
    end: number,
    signal: AbortSignal
  ): Promise<void> {
    if (!isPending(sb, cursor)) {
      const target = getFirstMissingChunk(sb, cursor, end);

      if (target) {
        const [start, chunkEnd] = target;
        const failure = getFetchFailure(sb, start, chunkEnd);

        if (failure?.attempts && failure.attempts >= MAX_FETCH_ATTEMPTS) {
          throw new Error(`Failed to fetch audio range ${start}-${chunkEnd}`);
        }

        const retryDelay = getRetryDelay(sb, start, chunkEnd);
        if (retryDelay > 0) {
          await this.waitForData(sb, signal, retryDelay);
          return;
        }

        void this.fetchAndCache(sb, start, chunkEnd);
      }
    }

    await this.waitForData(sb, signal);
  }

  private createConsumerStream(
    sb: SongBuffer,
    start: number,
    end: number
  ): ReadableStream<Uint8Array> {
    let cursor = start;
    const abortController = new AbortController();

    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          while (cursor <= end) {
            if (this.songBuffer !== sb) throw new Error("Song changed");

            const availableEnd = getAvailableEnd(sb, cursor);

            if (availableEnd !== -1) {
              const chunkEnd = Math.min(
                availableEnd,
                end,
                cursor + CONSUMER_CHUNK_SIZE - 1
              );
              controller.enqueue(createCachedSlice(sb, cursor, chunkEnd));
              cursor = chunkEnd + 1;

              if (cursor > end) controller.close();
              return;
            }

            await this.waitForMissingConsumerData(
              sb,
              cursor,
              end,
              abortController.signal
            );
          }

          controller.close();
        } catch (e) {
          try {
            controller.error(e);
          } catch {
            /* Browser abruptly closed connection */
          }
        }
      },
      cancel() {
        abortController.abort();
      },
    });
  }
  // #endregion

  // #region Background preload
  private backgroundFetchFull(sb: SongBuffer): void {
    if (sb.backgroundFetchInProgress) return;
    sb.backgroundFetchInProgress = true;

    void (async () => {
      try {
        while (
          this.songBuffer === sb &&
          (await this.fetchNextBackgroundChunk(sb))
        ) {
          // Keep preloading until the buffer is complete, replaced, or blocked.
        }
      } catch {
        // Suppress background errors. Will gracefully resume later.
      } finally {
        if (this.songBuffer === sb) sb.backgroundFetchInProgress = false;
      }
    })();
  }
  // #endregion

  // #region Request handling
  async handleRequest(songId: string, request: Request): Promise<Response> {
    const playInfo = this.currentAudioPlayInfo;
    const generation = this.playInfoGeneration;

    if (!playInfo || playInfo.songId !== songId) {
      return new Response("No audio play info available for this song", {
        status: 404,
      });
    }

    if (playInfo.type !== 4) {
      return this.handleLocalRequest(songId, playInfo, generation);
    }

    return this.handleRemoteRequest(songId, playInfo, generation, request);
  }

  private async handleLocalRequest(
    songId: string,
    playInfo: Extract<AudioPlayInfo, { type: 0 }>,
    generation: number
  ): Promise<Response> {
    const fileStat = await stat(playInfo.path);

    if (!this.isCurrentGeneration(generation, songId)) {
      return new Response("Audio play info changed", { status: 404 });
    }

    const nodeStream = createReadStream(playInfo.path);

    return new Response(createNodeWebStream(nodeStream), {
      status: 200,
      headers: {
        "Content-Type":
          mime.getType(playInfo.path) || "application/octet-stream",
        "Content-Length": String(fileStat.size),
      },
    });
  }

  private async handleRemoteRequest(
    songId: string,
    playInfo: Extract<AudioPlayInfo, { type: 4 }>,
    generation: number,
    request: Request
  ): Promise<Response> {
    const parsedRange = parseRangeHeader(request.headers.get("range"));
    if (!parsedRange) return new Response("Invalid range", { status: 416 });

    const sbResult = await this.getRemoteSongBuffer(
      songId,
      playInfo,
      generation,
      parsedRange
    );
    if (sbResult instanceof Response) return sbResult;

    const { sb, initialStreamData } = sbResult;
    const resolvedEnd = Math.min(
      parsedRange.end ?? sb.totalSize - 1,
      sb.totalSize - 1
    );

    if (parsedRange.start >= sb.totalSize || parsedRange.start > resolvedEnd) {
      initialStreamData?.stream.destroy();
      return new Response("Range not satisfiable", {
        status: 416,
        headers: { "Content-Range": `bytes */${sb.totalSize}` },
      });
    }

    const leftoverStream = this.startMissingFetches(
      sb,
      parsedRange.start,
      resolvedEnd,
      initialStreamData
    );
    leftoverStream?.stream.destroy();

    if (request.headers.has("range")) {
      this.backgroundFetchFull(sb);
    }

    return new Response(
      this.createConsumerStream(sb, parsedRange.start, resolvedEnd),
      {
        status: request.headers.has("range") ? 206 : 200,
        headers: {
          "Content-Type": sb.contentType,
          "Content-Length": String(resolvedEnd - parsedRange.start + 1),
          ...(request.headers.has("range") && {
            "Content-Range": `bytes ${parsedRange.start}-${resolvedEnd}/${sb.totalSize}`,
          }),
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
        },
      }
    );
  }

  private async getRemoteSongBuffer(
    songId: string,
    playInfo: Extract<AudioPlayInfo, { type: 4 }>,
    generation: number,
    range: ParsedRange
  ): Promise<
    | {
        sb: SongBuffer;
        initialStreamData: OpenedRangeStream | null;
      }
    | Response
  > {
    const existingBuffer = this.songBuffer;
    if (
      existingBuffer?.songId === songId &&
      existingBuffer.generation === generation
    ) {
      return { sb: existingBuffer, initialStreamData: null };
    }

    try {
      const openedStream = await openRangeStream(
        playInfo.musicurl,
        range.start,
        range.end
      );
      const info = parseSizeFromHeaders(openedStream.headers);

      if (!info.totalSize) {
        openedStream.stream.destroy();
        return new Response("Could not determine file size", { status: 502 });
      }

      if (!this.isCurrentGeneration(generation, songId)) {
        openedStream.stream.destroy();
        return new Response("Audio play info changed", { status: 404 });
      }

      const sb = this.ensureSongBuffer(
        songId,
        playInfo,
        generation,
        playInfo.musicurl,
        info.totalSize,
        info.contentType
      );

      return { sb, initialStreamData: openedStream };
    } catch {
      return new Response("Upstream stream initialization error", {
        status: 502,
      });
    }
  }
  // #endregion
}
