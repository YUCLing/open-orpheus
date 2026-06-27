import crypto from "node:crypto";
import fs from "node:fs/promises";
import { dirname } from "node:path";
import type { WriteStream } from "node:fs";

import type { Request } from "got";
import Emittery from "emittery";

import { client } from "./request";

export type DownloadStartOptions = {
  headers?: Record<string, string>;
  md5?: string;
  // Preferred total size in bytes
  size?: number;
};

export type DownloadProgress = {
  path: string;
  percent: number;
  total: number;
  downloaded: number;
  speed: number;
};

export type DownloadTaskEvents = {
  progress: DownloadProgress;
  end: DownloadProgress;
  error: unknown;
};

export class DownloadTask extends Emittery<DownloadTaskEvents> {
  private hash: crypto.Hash | null;
  private fsHandle: fs.FileHandle | null = null;
  private request: Request | null = null;
  private writeStream: WriteStream | null = null;

  private ema = 0; // Exponential Moving Average for speed
  private lastTime = 0;
  private lastBytes = 0;

  // Throttle UI/Progress updates to ensure EMA mathematical accuracy and prevent UI lag
  private static readonly UPDATE_INTERVAL_MS = 500;

  get isPaused() {
    return this.request?.isPaused() ?? true;
  }

  constructor(
    public url: string,
    public path: string,
    public options: DownloadStartOptions
  ) {
    super();

    this.hash = options.md5 ? crypto.createHash("md5") : null;
  }

  private updateSpeed(isEnd = false) {
    if (!this.request) return;

    const now = performance.now();
    const prog = this.request.downloadProgress;
    const downloaded = prog.transferred;

    const deltaTime = now - this.lastTime;

    // Only update and emit if enough time has passed OR if it's the final forced emit
    if (deltaTime >= DownloadTask.UPDATE_INTERVAL_MS || isEnd) {
      const deltaBytes = downloaded - this.lastBytes;

      if (deltaTime > 0) {
        const instantSpeed = (deltaBytes * 1000) / deltaTime; // bytes/sec
        this.ema = this.ema
          ? 0.8 * this.ema + 0.2 * instantSpeed
          : instantSpeed;
      }

      this.emit("progress", {
        path: this.path,
        // Hardcode percent to 1 on completion to prevent 0% UI flashes when Content-Length is missing
        percent: isEnd ? 1 : prog.percent,
        // If it's the end and total is missing, the total is exactly what was downloaded
        total: isEnd
          ? prog.total || downloaded || this.options.size || 0
          : prog.total || this.options.size || 0,
        downloaded,
        speed: this.ema,
      });

      this.lastTime = now;
      this.lastBytes = downloaded;
    }
  }

  private async errored() {
    await this.cancel().catch(() => {}); // Ensure resources are cleaned up
    // Clean up partial file.
    await fs.rm(this.path, { force: true }).catch(() => {});
  }

  async start() {
    try {
      // Ensure the directory exists
      await fs.mkdir(dirname(this.path), { recursive: true });

      this.fsHandle = await fs.open(this.path, "w");
      this.writeStream = this.fsHandle.createWriteStream();

      this.request = client.stream(this.url, {
        headers: this.options.headers,
      });

      // Initialize trackers exactly when data is about to start flowing
      this.lastTime = performance.now();
      this.lastBytes = 0;
      this.ema = 0;

      this.request.on("data", (chunk: Buffer) => {
        this.hash?.update(chunk);
        this.updateSpeed();
      });

      this.request.on("end", async () => {
        if (this.hash) {
          const calculatedHash = this.hash.digest("hex");
          if (this.options.md5 && calculatedHash !== this.options.md5) {
            console.error(
              `MD5 mismatch: expected ${this.options.md5}, got ${calculatedHash}`
            );
            this.errored().catch(() => {}); // Clean up on error
            this.emit("error", new Error("MD5 checksum verification failed"));
            return;
          }
        }

        this.writeStream?.end();
        await this.fsHandle?.close().catch(() => {}); // Ensure we attempt to close the file handle

        // Force a final speed/progress update to ensure it reaches 100%
        this.updateSpeed(true);

        const prog = this.request?.downloadProgress;
        const downloaded = prog?.transferred || 0;

        this.emit("end", {
          path: this.path,
          percent: 1,
          total: prog?.total || downloaded || this.options.size || 0,
          downloaded,
          speed: this.ema,
        }).catch((err) => this.emit("error", err));
      });

      this.request.on("error", async (error) => {
        console.error("Download error:", error);
        this.errored().catch(() => {}); // Ensure we attempt to clean up on error
        this.emit("error", error);
      });

      this.writeStream.on("error", async (error) => {
        console.error("Write stream error:", error);
        this.errored().catch(() => {}); // Ensure we attempt to clean up on error
        this.emit("error", error);
      });

      this.request.pipe(this.writeStream);
    } catch (error) {
      console.error("Error download:", error);
      this.errored().catch(() => {}); // Ensure we attempt to clean up on error
      this.emit("error", error);
    }
  }

  pause() {
    this.request?.pause();
  }

  resume() {
    this.lastTime = performance.now();
    // Use actual transferred bytes instead of 0 to prevent a massive instantSpeed spike
    this.lastBytes = this.request?.downloadProgress?.transferred || 0;
    // We intentionally do not reset ema to 0 so the UI doesn't drop to 0
    this.request?.resume();
  }

  async cancel() {
    this.request?.destroy();
    this.writeStream?.end();
    await this.fsHandle?.close().catch(() => {});
  }
}

export default async function startDownload(
  url: string,
  path: string,
  options: DownloadStartOptions,
  start = true
): Promise<DownloadTask> {
  const task = new DownloadTask(url, path, options);

  if (start) await task.start();

  return task;
}
