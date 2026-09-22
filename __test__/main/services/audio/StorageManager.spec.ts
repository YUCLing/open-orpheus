import { beforeEach, describe, expect, it, vi } from "vitest";

// memfs-backed, see `__mocks__/fs/promises.cts`.
vi.mock("node:fs/promises");
// `createReadStream` comes from `node:fs`, which the manual mock doesn't cover.
vi.mock("node:fs", async () => (await import("memfs")).fs);

import { vol } from "memfs";

import StorageManager from "@main/services/audio/StorageManager";

const FILE = "/stream/audio.tmp";

function manager() {
  return new StorageManager(FILE);
}

async function collect(readable: AsyncIterable<Uint8Array>) {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("StorageManager", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("writes and reads a chunk back", async () => {
    const storage = manager();

    await storage.write(0, Buffer.from("hello"));
    await expect(storage.readBuffer(0, 5)).resolves.toEqual(
      Buffer.from("hello")
    );
    await expect(storage.readBuffer(0, 2)).resolves.toEqual(Buffer.from("he"));

    await storage.close();
  });

  it("supports writes at arbitrary offsets", async () => {
    const storage = manager();

    await storage.write(10, Buffer.from("bb"));
    await storage.write(0, Buffer.from("aa"));
    await storage.setLength(12);

    await expect(storage.readBuffer(0, 12)).resolves.toEqual(
      Buffer.from("aa\0\0\0\0\0\0\0\0bb")
    );

    await storage.close();
  });

  it("fills unwritten regions with zeroes", async () => {
    const storage = manager();

    await storage.setLength(16);
    await storage.write(4, Buffer.from([1, 2]));

    const buffer = await storage.readBuffer(0, 16);
    expect(buffer.subarray(0, 4)).toEqual(Buffer.alloc(4));
    expect(buffer.subarray(4, 6)).toEqual(Buffer.from([1, 2]));
    expect(buffer.subarray(6)).toEqual(Buffer.alloc(10));

    await storage.close();
  });

  it("ignores empty writes", async () => {
    const storage = manager();

    await storage.write(0, new Uint8Array(0));
    await expect(storage.readBuffer(0, 1)).resolves.toEqual(Buffer.alloc(1));

    await storage.close();
  });

  it("returns an empty buffer for an empty range", async () => {
    const storage = manager();

    await expect(storage.readBuffer(5, 5)).resolves.toEqual(Buffer.alloc(0));
    await expect(storage.readBuffer(10, 3)).resolves.toEqual(Buffer.alloc(0));

    await storage.close();
  });

  it("accepts byte views of larger buffers", async () => {
    const storage = manager();
    const backing = Buffer.from("xxhelloyy");
    // A view with a non-zero byteOffset into the backing buffer.
    const view = new Uint8Array(backing.buffer, backing.byteOffset + 2, 5);

    await storage.write(0, view);

    await expect(storage.readBuffer(0, 5)).resolves.toEqual(
      Buffer.from("hello")
    );

    await storage.close();
  });

  it("keeps concurrent writes intact", async () => {
    const storage = manager();

    await Promise.all([
      storage.write(0, Buffer.from("first")),
      storage.write(10, Buffer.from("second")),
    ]);

    await expect(storage.readBuffer(0, 16)).resolves.toEqual(
      Buffer.from("first" + "\0".repeat(5) + "second")
    );

    await storage.close();
  });

  it("streams a range in chunks", async () => {
    const storage = manager();
    const payload = Buffer.alloc(150 * 1024, 7);
    await storage.write(0, payload);

    const chunks: Buffer[] = [];
    for await (const chunk of storage.readRange(0, payload.length)) {
      chunks.push(Buffer.from(chunk));
    }

    expect(chunks.length).toBeGreaterThan(1);
    expect(Buffer.concat(chunks)).toEqual(payload);
    expect(chunks[0].length).toBe(64 * 1024);

    await storage.close();
  });

  it("exposes a readable stream over a range", async () => {
    const storage = manager();
    await storage.write(0, Buffer.from("0123456789"));

    await expect(collect(storage.createReadStream(2, 5))).resolves.toEqual(
      Buffer.from("234")
    );
    expect(storage.createReadStream(5, 5).readableLength).toBe(0);

    await storage.close();
  });

  it("refuses to work after being closed", async () => {
    const storage = manager();
    await storage.write(0, Buffer.from("data"));
    await storage.close();

    await expect(storage.write(0, Buffer.from("more"))).rejects.toThrow(
      "Storage manager has been closed"
    );
    await expect(storage.readBuffer(0, 4)).rejects.toThrow(
      "Storage manager has been closed"
    );
  });

  it("is safe to close twice", async () => {
    const storage = manager();
    await storage.open();

    await expect(storage.close()).resolves.toBeUndefined();
    await expect(storage.close()).resolves.toBeUndefined();
  });

  it("deletes the backing file", async () => {
    const storage = manager();
    await storage.write(0, Buffer.from("data"));

    await storage.delete();

    expect(vol.existsSync(FILE)).toBe(false);
    await expect(manager().readBuffer(0, 0)).resolves.toEqual(Buffer.alloc(0));
  });
});
