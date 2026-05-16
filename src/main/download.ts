import crypto from "node:crypto";
import fs from "node:fs/promises";
import { dirname } from "node:path";
import type { WriteStream } from "node:fs";

import type { Request } from "got";

import client from "./request";
import parentLogger from "./logger";

const logger = parentLogger.child({ name: "download" });

export type DownloadStartOptions = {
  headers?: Record<string, string>;
  md5?: string;
  // Preferred total size in bytes
  size?: number;
};

export type ProgressEvent = CustomEvent<{
  percent: number;
  total?: number;
  downloaded: number;
  speed: number; // bytes per second
}>;

export type EndEvent = CustomEvent<{
  path: string;
  total?: number;
  downloaded: number;
  speed: number; // bytes per second, final speed at the end of the download
}>;

export type ErrorEvent = CustomEvent<{
  error: Error;
}>;

export class DownloadTask extends EventTarget {
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

      this.dispatchEvent(
        new CustomEvent("progress", {
          detail: {
            percent: prog.percent,
            total: prog.total || this.options.size,
            downloaded,
            speed: this.ema,
          },
        })
      );

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
        logger.info({ dest: this.path }, "Download completed");
        if (this.hash) {
          const calculatedHash = this.hash.digest("hex");
          if (this.options.md5 && calculatedHash !== this.options.md5) {
            logger.error(
              { expected: this.options.md5, got: calculatedHash },
              "Downloaded file MD5 mismatch"
            );
            this.errored().catch(() => {}); // Clean up on error
            this.dispatchEvent(
              new CustomEvent("error", {
                detail: new Error("MD5 checksum verification failed"),
              })
            );
            return;
          }
        }

        this.writeStream?.end();
        await this.fsHandle?.close().catch(() => {}); // Ensure we attempt to close the file handle

        this.dispatchEvent(
          new CustomEvent("end", {
            detail: {
              path: this.path,
              total:
                this.request?.downloadProgress?.total || this.options.size || 0,
              downloaded: this.request?.downloadProgress?.transferred || 0,
              speed: this.ema,
            },
          })
        );
      });

      this.request.on("error", async (error) => {
        logger.error({ dest: this.path, err: error }, "Download error");
        this.errored().catch(() => {}); // Ensure we attempt to clean up on error
        this.dispatchEvent(new CustomEvent("error", { detail: error }));
      });
      this.writeStream.on("error", async (error) => {
        logger.error({ dest: this.path, err: error }, "Download write error");
        this.errored().catch(() => {}); // Ensure we attempt to clean up on error
        this.dispatchEvent(new CustomEvent("error", { detail: error }));
      });

      this.request.pipe(this.writeStream);
    } catch (error) {
      logger.error(
        { dest: this.path },
        "Unrecognized error downloading: %s",
        error
      );
      this.errored().catch(() => {}); // Ensure we attempt to clean up on error
      this.dispatchEvent(new CustomEvent("error", { detail: error }));
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
