import { createReadStream } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";

import type { FileHandle } from "node:fs/promises";

const LOCAL_READ_CHUNK_SIZE = 64 * 1024;

export default class StorageManager {
  private fileHandle: FileHandle | null = null;
  private openingPromise: Promise<FileHandle> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(public readonly filePath: string) {}

  async open() {
    await this.getFileHandle();
  }

  async setLength(length: number) {
    const fileHandle = await this.getFileHandle();
    await fileHandle.truncate(length);
  }

  async write(position: number, chunk: Uint8Array) {
    if (chunk.byteLength === 0) return;

    const buffer = Buffer.from(
      chunk.buffer,
      chunk.byteOffset,
      chunk.byteLength
    );
    const writeTask = this.writeQueue.then(async () => {
      const fileHandle = await this.getFileHandle();
      let written = 0;

      while (written < buffer.byteLength) {
        const { bytesWritten } = await fileHandle.write(
          buffer,
          written,
          buffer.byteLength - written,
          position + written
        );

        if (bytesWritten === 0) {
          throw new Error("Failed to write audio chunk to sparse file");
        }

        written += bytesWritten;
      }
    });

    this.writeQueue = writeTask.then(
      () => {},
      () => {}
    );
    await writeTask;
  }

  async readBuffer(start: number, end: number) {
    const length = Math.max(0, end - start);
    if (length === 0) return Buffer.alloc(0);

    await this.writeQueue;
    const fileHandle = await this.getFileHandle();
    const buffer = Buffer.alloc(length);
    let read = 0;

    while (read < length) {
      const { bytesRead } = await fileHandle.read(
        buffer,
        read,
        length - read,
        start + read
      );

      if (bytesRead === 0) break;
      read += bytesRead;
    }

    return buffer;
  }

  async *readRange(start: number, end: number) {
    let cursor = start;

    while (cursor < end) {
      const chunkEnd = Math.min(end, cursor + LOCAL_READ_CHUNK_SIZE);
      const chunk = await this.readBuffer(cursor, chunkEnd);
      if (chunk.byteLength === 0) break;
      yield chunk;
      cursor = chunkEnd;
    }
  }

  createReadStream(start: number, end: number) {
    if (end <= start) return Readable.from([]);
    return createReadStream(this.filePath, { start, end: end - 1 });
  }

  async close() {
    this.closed = true;
    await this.writeQueue.catch(() => {});

    const fileHandle =
      this.fileHandle ??
      (this.openingPromise
        ? await this.openingPromise.catch(() => null)
        : null);

    this.fileHandle = null;
    this.openingPromise = null;
    await fileHandle?.close().catch(() => {});
  }

  async delete() {
    await this.close();
    await rm(this.filePath, { force: true });
  }

  private async getFileHandle() {
    if (this.closed) {
      throw new Error("Storage manager has been closed");
    }

    if (this.fileHandle) return this.fileHandle;

    if (!this.openingPromise) {
      this.openingPromise = (async () => {
        await mkdir(dirname(this.filePath), { recursive: true });
        const fileHandle = await open(this.filePath, "w+");
        this.fileHandle = fileHandle;
        return fileHandle;
      })();
    }

    return this.openingPromise;
  }
}
