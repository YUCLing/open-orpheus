import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import mime from "mime";

import type { AudioPlayInfo } from "../../../preload/Player";
import type PlayCacheManager from "../cache/PlayCacheManager";
import { normalizePath } from "../../platform/utils/path";
import { toError } from "@shared/util";
import type { OnlineStreamer } from "./OnlineStreamer";
import type { WindowService } from "../../bootstrap/types";

enum MediaType {
  Local,
  URL,
}

type MediaState = { playInfo: AudioPlayInfo } & (
  | {
      type: MediaType.Local;
      path: string;
    }
  | {
      type: MediaType.URL;
      streamer: OnlineStreamer;
    }
);

/**
 * Main-process engine for media-element playback. It never decodes — Chromium
 * plays the `<audio>` element — it only serves that element over `audio://audio`
 * from the current load: a local file (ranged reads) or an `OnlineStreamer`
 * (URL, cache-on-complete). Distinct from `Av3aEngine`, which manages the AV3A
 * decode utility process; exactly one of them is active at a time and the
 * renderer routes which one.
 */
export interface MediaEngineDeps {
  windows: Pick<WindowService, "currentWindow">;
  /**
   * Read at use, not at construction: the play cache is initialised after this
   * engine exists, so a captured value would be the `null` from before that.
   */
  playCache: () => Pick<PlayCacheManager, "cacheTrack"> | null;
  /** Builds the streamer for a URL. Injected because a streamer owns a temp file. */
  createStreamer: (url: string) => OnlineStreamer;
}

export class MediaEngine {
  private state: MediaState | null = null;

  constructor(private readonly deps: MediaEngineDeps) {}

  /**
   * Deletions `stop()` started but did not wait for.
   *
   * A song switch must not block on deleting the previous file, so those
   * deletions run unattended — but a shutdown has to wait for them, or a file
   * whose deletion was still in flight outlives the process and is only
   * reclaimed by the next launch's cleanup.
   */
  private pendingDestructions = new Set<Promise<void>>();

  get active(): boolean {
    return this.state !== null;
  }

  /** Delete a retired streamer's file without blocking the caller. */
  private destroyInBackground(streamer: OnlineStreamer): void {
    const done = streamer.destroy().catch((e) => {
      LOGGER.error({ err: toError(e) }, `Failed to destroy previous OnlineStreamer`);
    });
    this.pendingDestructions.add(done);
    // Drop the reference once it settles, so the set tracks only what is still
    // in flight.
    void done.finally(() => {
      this.pendingDestructions.delete(done);
    });
  }

  private sendProgress(prog: number) {
    const mainWindow = this.deps.windows.currentWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("audio.onProgress", prog);
  }

  /**
   * Register the serving state for a media-element (non-AV3A) play info.
   * Local files are served by path; URLs get an `OnlineStreamer` whose
   * completion writes the download into the play cache.
   */
  async activate(playInfo: AudioPlayInfo): Promise<void> {
    if (playInfo.type === 0) {
      // Local File Play
      playInfo.path = normalizePath(playInfo.path);
      this.state = { type: MediaType.Local, playInfo, path: playInfo.path };
      return;
    }
    if (playInfo.type !== 4) return;

    // URL Play
    const songId = playInfo.songId;
    const streamer = this.deps.createStreamer(playInfo.musicurl);

    streamer.on("progress", (e) => {
      this.sendProgress(e.data.loaded / e.data.total);
    });

    streamer.on("complete", async () => {
      if (this.state?.type !== MediaType.URL) return;
      if (this.state.streamer !== streamer) return;
      if (this.state.playInfo.songId !== songId) return;
      try {
        const buf = await streamer.readBuffer();
        this.deps
          .playCache()
          ?.cacheTrack(songId, buf, {
            md5: playInfo.md5,
            bitrate: playInfo.bitrate,
            playInfoStr: playInfo.playInfoStr,
            volumeGain: 0,
            fileSize: buf.length,
          })
          .catch((err) => {
            LOGGER.error({ err: toError(err) }, `Failed to cache track`);
          });
      } catch (e) {
        LOGGER.error({ err: toError(e) }, `Cannot get streamed track`);
      }
    });

    streamer.on("error", (e) => {
      LOGGER.error({ err: e.data }, `OnlineStreamer errored`);
    });

    this.state = { type: MediaType.URL, playInfo, streamer };
  }

  /**
   * Retire the current serving state. Any streamer is destroyed in the
   * background (its file deletion must not block a fast song switch).
   */
  async stop(): Promise<void> {
    const current = this.state;
    this.state = null;
    if (current?.type === MediaType.URL) {
      this.destroyInBackground(current.streamer);
    }
  }

  /**
   * Retire the current serving state and wait for every streamer's file to be
   * deleted, including deletions {@link stop} left running.
   *
   * Distinct from {@link stop}, which deliberately does not wait: a song switch
   * must not block on deleting the previous file, but a shutdown has nothing
   * after it and wants the temp file gone rather than left for the next launch.
   */
  async dispose(): Promise<void> {
    const current = this.state;
    this.state = null;

    const deletions = [...this.pendingDestructions];
    if (current?.type === MediaType.URL) {
      deletions.push(current.streamer.destroy());
    }

    // Every deletion has to settle, and one failing must not skip the rest or
    // stop disposal — but a failure must not be swallowed either. The
    // deletions `stop()` left running already log themselves; inspecting the
    // results covers the current stream, whose `destroy()` is awaited here.
    const results = await Promise.allSettled(deletions);
    for (const result of results) {
      if (result.status === "rejected") {
        LOGGER.error({ err: toError(result.reason) }, `Failed to destroy OnlineStreamer`);
      }
    }
  }

  /** Serve an `audio://audio` request (the `<audio>` element) for this state. */
  async serve(request: Request): Promise<Response> {
    const current = this.state;
    if (!current) return new Response("No play info yet", { status: 400 });

    if (current.type === MediaType.URL) {
      return current.streamer.handleRequest(request);
    }

    const filePath = current.path;
    const fileStat = await stat(filePath);
    const fileSize = fileStat.size;
    const mimeType = mime.getType(filePath) || "application/octet-stream";

    this.sendProgress(1);

    const rangeHeader = request.headers.get("Range");
    if (rangeHeader) {
      const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

        if (start <= end && start < fileSize) {
          const clampedEnd = Math.min(end, fileSize - 1);
          const chunkSize = clampedEnd - start + 1;
          const nodeStream = createReadStream(filePath, {
            start,
            end: clampedEnd,
          });

          return new Response(Readable.toWeb(nodeStream), {
            status: 206,
            headers: {
              "Content-Type": mimeType,
              "Content-Length": String(chunkSize),
              "Content-Range": `bytes ${start}-${clampedEnd}/${fileSize}`,
              "Accept-Ranges": "bytes",
            },
          });
        }
      }
      // Invalid or unsatisfiable range — return 416
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: {
          "Content-Range": `bytes */${fileSize}`,
        },
      });
    }

    const nodeStream = createReadStream(filePath);
    return new Response(Readable.toWeb(nodeStream), {
      status: 200,
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(fileSize),
        "Accept-Ranges": "bytes",
      },
    });
  }
}
