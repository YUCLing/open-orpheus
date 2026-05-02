import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import mime from "mime";

import type { AudioPlayInfo } from "../../preload/Player";
import client from "../request";

// #region Interval helpers
type Interval = [start: number, end: number]; // inclusive [start, end]
// #endregion

// #region Per-song buffer state
interface SongBuffer {
  songId: string;
  url: string;
  totalSize: number;
  buffer: Buffer;
  intervals: Interval[];
  backgroundFetchInProgress: boolean;
  contentType: string;
}

export default class AudioStreamer extends EventTarget {
  private songBuffer: SongBuffer | null = null;
  private currentAudioPlayInfo: AudioPlayInfo | null = null;

  get buffer() {
    return this.songBuffer;
  }

  get audioPlayInfo() {
    return this.currentAudioPlayInfo;
  }

  constructor() {
    super();
  }

  private static mergeInterval(intervals: Interval[], added: Interval): void {
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

  /** Return sub-ranges of [start, end] not yet covered by `have`. */
  private static missingRanges(
    have: Interval[],
    start: number,
    end: number
  ): Interval[] {
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

  private static downloadedBytes(intervals: Interval[]): number {
    return intervals.reduce((total, [s, e]) => total + (e - s + 1), 0);
  }

  setPlayInfo(playInfo: AudioPlayInfo | null): void {
    this.currentAudioPlayInfo = playInfo;
  }

  private onProgress(progress: number): void {
    this.dispatchEvent(
      new CustomEvent<number>("progress", { detail: progress })
    );
  }

  private onComplete(): void {
    if (!this.songBuffer || !this.currentAudioPlayInfo) return;
    this.dispatchEvent(new Event("complete"));
  }

  private parseSizeFromHeaders(headers: IncomingHttpHeaders): {
    totalSize: number;
    contentType: string;
  } {
    const getHeader = (v: string | string[] | undefined) =>
      Array.isArray(v) ? v[0] : v;

    const contentType = getHeader(headers["content-type"]) ?? "audio/mpeg";
    const cr = getHeader(headers["content-range"]);
    if (cr) {
      const match = cr.match(/\/(\d+)/);
      if (match) return { totalSize: Number(match[1]), contentType };
    }
    const cl = getHeader(headers["content-length"]);
    return { totalSize: cl ? Number(cl) : 0, contentType };
  }

  private async openRangeStream(
    url: string,
    start: number,
    end?: number
  ): Promise<{
    stream: Readable;
    headers: IncomingHttpHeaders;
    actualStart: number;
  }> {
    const rangeValue =
      end !== undefined ? `bytes=${start}-${end}` : `bytes=${start}-`;

    // Cast to native node stream to ensure we have .destroy() and AsyncIterable support
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
      const cr = response.headers["content-range"];
      if (typeof cr === "string") {
        const match = cr.match(/bytes\s+(\d+)-/i);
        if (match) actualStart = Number(match[1]);
      }
    } else if (response.statusCode === 200) {
      actualStart = 0; // Server ignored Range header, sent whole file
    }

    return { stream, headers: response.headers, actualStart };
  }

  private ensureSongBuffer(
    songId: string,
    url: string,
    totalSize: number,
    contentType: string
  ): SongBuffer {
    if (this.songBuffer?.songId === songId) return this.songBuffer;

    this.songBuffer = {
      songId,
      url,
      totalSize,
      buffer: Buffer.alloc(totalSize),
      intervals: [],
      backgroundFetchInProgress: false,
      contentType,
    };
    return this.songBuffer;
  }

  /**
   * Universal method that downloads chunks, saves them to the song buffer, and
   * optionally forwards precisely sliced bytes to the client stream controller.
   */
  private async downloadAndCache(
    sb: SongBuffer,
    stream: Readable,
    actualStart: number,
    clientStream?: {
      controller: ReadableStreamDefaultController<Uint8Array>;
      reqStart: number;
      reqEnd: number;
    }
  ): Promise<void> {
    let offset = actualStart;

    for await (const value of stream) {
      if (this.songBuffer !== sb) {
        stream.destroy();
        throw new Error("Song changed");
      }

      const chunk = Buffer.isBuffer(value)
        ? value
        : Buffer.from(value as Uint8Array | string);
      if (offset >= sb.totalSize) break;

      const writableLength = Math.min(chunk.length, sb.totalSize - offset);
      chunk.copy(sb.buffer, offset, 0, writableLength);

      const chunkStart = offset;
      const chunkEnd = offset + writableLength - 1;

      // Extract and stream ONLY the strict boundaries the client browser requested
      if (
        clientStream &&
        chunkEnd >= clientStream.reqStart &&
        chunkStart <= clientStream.reqEnd
      ) {
        const sliceStart = Math.max(0, clientStream.reqStart - chunkStart);
        const sliceEnd = Math.min(
          writableLength,
          clientStream.reqEnd - chunkStart + 1
        );

        const toEnqueue = chunk.subarray(sliceStart, sliceEnd);
        if (toEnqueue.length > 0) {
          clientStream.controller.enqueue(new Uint8Array(toEnqueue));
        }
      }

      if (writableLength > 0) {
        AudioStreamer.mergeInterval(sb.intervals, [chunkStart, chunkEnd]);
      }

      offset += writableLength;
      this.onProgress(
        AudioStreamer.downloadedBytes(sb.intervals) / sb.totalSize
      );
    }

    if (AudioStreamer.downloadedBytes(sb.intervals) >= sb.totalSize) {
      this.onComplete();
    }
  }

  /** Serves a range seamlessly by bridging cached buffer data and live fetched streams */
  private async streamRange(
    sb: SongBuffer,
    start: number,
    end: number,
    controller: ReadableStreamDefaultController<Uint8Array>
  ): Promise<void> {
    const segments: Array<{ have: boolean; start: number; end: number }> = [];
    let cursor = start;

    for (const [s, e] of sb.intervals) {
      if (s > end) break;
      if (e < cursor) continue;
      if (s > cursor) {
        segments.push({
          have: false,
          start: cursor,
          end: Math.min(s - 1, end),
        });
      }
      const covStart = Math.max(s, cursor);
      const covEnd = Math.min(e, end);
      if (covStart <= covEnd) {
        segments.push({ have: true, start: covStart, end: covEnd });
      }
      cursor = Math.max(cursor, e + 1);
      if (cursor > end) break;
    }
    if (cursor <= end) segments.push({ have: false, start: cursor, end });

    for (const seg of segments) {
      if (this.songBuffer !== sb) throw new Error("Song changed");

      if (seg.have) {
        const copy = new Uint8Array(seg.end - seg.start + 1);
        sb.buffer.copy(Buffer.from(copy.buffer), 0, seg.start, seg.end + 1);
        controller.enqueue(copy);
      } else {
        const { stream, actualStart } = await this.openRangeStream(
          sb.url,
          seg.start,
          seg.end
        );
        await this.downloadAndCache(sb, stream, actualStart, {
          controller,
          reqStart: seg.start,
          reqEnd: seg.end,
        });
      }
    }
  }

  private backgroundFetchFull(sb: SongBuffer): void {
    if (sb.backgroundFetchInProgress) return;
    sb.backgroundFetchInProgress = true;

    void (async () => {
      try {
        while (this.songBuffer === sb) {
          const gaps = AudioStreamer.missingRanges(
            sb.intervals,
            0,
            sb.totalSize - 1
          );
          if (gaps.length === 0) break;

          const { stream, actualStart } = await this.openRangeStream(
            sb.url,
            gaps[0][0],
            gaps[0][1]
          );
          await this.downloadAndCache(sb, stream, actualStart);
        }
      } catch {
        // Suppress background errors. Will gracefully resume later if user seeks.
      } finally {
        if (this.songBuffer === sb) sb.backgroundFetchInProgress = false;
      }
    })();
  }

  async handleRequest(songId: string, request: Request): Promise<Response> {
    if (
      !this.currentAudioPlayInfo ||
      this.currentAudioPlayInfo.songId !== songId
    ) {
      return new Response("No audio play info available for this song", {
        status: 404,
      });
    }

    if (this.currentAudioPlayInfo.type !== 4) {
      // Local file bypass
      const buf = await readFile(this.currentAudioPlayInfo.path);
      this.onProgress(1);
      this.onComplete();
      return new Response(buf, {
        status: 200,
        headers: {
          "Content-Type":
            mime.getType(this.currentAudioPlayInfo.path) ||
            "application/octet-stream",
          "Content-Length": String(buf.length),
        },
      });
    }

    const url = this.currentAudioPlayInfo.musicurl;
    const rangeHeader = request.headers.get("range");

    let start = 0;
    let end: number | undefined;

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (!match) return new Response("Invalid range", { status: 416 });
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : undefined;
    }

    let sb = this.songBuffer;
    let initialStreamData: { stream: Readable; actualStart: number } | null =
      null;

    // Lazily fetch meta & construct SongBuffer on first connection
    if (!sb || sb.songId !== songId) {
      try {
        const { stream, headers, actualStart } = await this.openRangeStream(
          url,
          start,
          end
        );
        const info = this.parseSizeFromHeaders(headers);

        if (!info.totalSize)
          return new Response("Could not determine file size", { status: 502 });

        sb = this.ensureSongBuffer(
          songId,
          url,
          info.totalSize,
          info.contentType
        );
        initialStreamData = { stream, actualStart }; // Kept so we don't throw away this response
      } catch {
        return new Response("Upstream stream initialization error", {
          status: 502,
        });
      }
    }

    const resolvedEnd = Math.min(end ?? sb.totalSize - 1, sb.totalSize - 1);

    if (start >= sb.totalSize || start > resolvedEnd) {
      return new Response("Range not satisfiable", {
        status: 416,
        headers: { "Content-Range": `bytes */${sb.totalSize}` },
      });
    }

    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try {
          if (initialStreamData) {
            // First ever request optimization: use the already open connection
            await this.downloadAndCache(
              sb,
              initialStreamData.stream,
              initialStreamData.actualStart,
              {
                controller,
                reqStart: start,
                reqEnd: resolvedEnd,
              }
            );
          } else {
            // Standard bridging for pre-existing cache
            await this.streamRange(sb, start, resolvedEnd, controller);
          }
          controller.close();
        } catch (e) {
          try {
            controller.error(e);
          } catch {
            /* Browser might have closed early */
          }
        } finally {
          // Fire up background preloading
          if (rangeHeader && this.songBuffer === sb)
            this.backgroundFetchFull(sb);
        }
      },
    });

    return new Response(stream, {
      status: rangeHeader ? 206 : 200,
      headers: {
        "Content-Type": sb.contentType,
        "Content-Length": String(resolvedEnd - start + 1),
        ...(rangeHeader && {
          "Content-Range": `bytes ${start}-${resolvedEnd}/${sb.totalSize}`,
        }),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      },
    });
  }
}

// #endregion
