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

  private updateSpeed() {
    if (!this.request) return;

    const now = Date.now();
    const prog = this.request.downloadProgress;
    const downloaded = prog.transferred;
    const deltaBytes = downloaded - this.lastBytes;
    const deltaTime = now - this.lastTime;

    if (deltaTime > 0) {
      const instantSpeed = (deltaBytes * 1000) / deltaTime; // bytes/sec
      this.ema = this.ema ? 0.8 * this.ema + 0.2 * instantSpeed : instantSpeed;

      this.emit("progress", {
        path: this.path,
        percent: prog.percent,
        total: prog.total || this.options.size || 0,
        downloaded,
        speed: this.ema,
      });

      this.lastTime = now;
      this.lastBytes = downloaded;
    }
  }

  private async errored() {
    await this.cancel().catch(() => {}); // Ensure resources are cleaned up
    await fs.rm(this.path).catch(() => {}); // Clean up partial file
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

        this.emit("end", {
          path: this.path,
          percent: 1,
          total:
            this.request?.downloadProgress?.total || this.options.size || 0,
          downloaded: this.request?.downloadProgress?.transferred || 0,
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
    this.lastTime = Date.now();
    this.lastBytes = 0;
    this.ema = 0;
    this.request?.resume();
  }

  async cancel() {
    this.request?.destroy();
    this.writeStream?.end();
    await this.fsHandle?.close();
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
