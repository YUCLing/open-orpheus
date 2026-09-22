import { beforeEach, describe, expect, it, vi } from "vitest";

// memfs-backed, see `__mocks__/fs/promises.cts`.
vi.mock("node:fs/promises");

import { vol } from "memfs";

import LyricCacheManager from "@main/services/cache/LyricCahceManager";

const CACHE_DIR = "/cache/lyrics";

function newManager(maxSizeBytes = 1024) {
  return new LyricCacheManager(CACHE_DIR, maxSizeBytes);
}

describe("LyricCacheManager", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("starts empty", async () => {
    const manager = newManager();

    await expect(manager.getStats()).resolves.toEqual({
      entryCount: 0,
      sizeBytes: 0,
    });
    await expect(manager.get("1")).resolves.toBeNull();
  });

  it("stores and reads a lyric", async () => {
    const manager = newManager();

    await manager.set("123", "hello lyrics");

    await expect(manager.get("123")).resolves.toBe("hello lyrics");
    await expect(manager.getStats()).resolves.toEqual({
      entryCount: 1,
      sizeBytes: 12,
    });
    expect(vol.existsSync(`${CACHE_DIR}/123`)).toBe(true);
  });

  it("uses the song id as the file name", async () => {
    const manager = newManager();
    await manager.set("456", "content");

    await expect(
      vol.promises.readFile(`${CACHE_DIR}/456`, "utf-8")
    ).resolves.toBe("content");
  });

  it("overwrites an existing entry without double counting its size", async () => {
    const manager = newManager();

    await manager.set("1", "short");
    await manager.set("1", "a much longer lyric text");

    await expect(manager.getStats()).resolves.toEqual({
      entryCount: 1,
      sizeBytes: 24,
    });
  });

  it("tracks multi-byte content by byte length", async () => {
    const manager = newManager();
    await manager.set("1", "不完美");

    // 3 CJK characters → 9 UTF-8 bytes.
    await expect(manager.getStats()).resolves.toEqual({
      entryCount: 1,
      sizeBytes: 9,
    });
  });

  it("returns null for a song that was never cached", async () => {
    const manager = newManager();
    await manager.set("1", "x");

    await expect(manager.get("2")).resolves.toBeNull();
    await expect(manager.getStats()).resolves.toEqual({
      entryCount: 1,
      sizeBytes: 1,
    });
  });

  it("rejects keys that would escape the cache directory", async () => {
    const manager = newManager();

    await expect(manager.get("a/b")).rejects.toThrow(/Invalid lyric cache key/);
    await expect(manager.set("a/b", "x")).rejects.toThrow(
      /Invalid lyric cache key/
    );
  });

  it("indexes files that already exist on disk", async () => {
    vol.fromJSON({ [`${CACHE_DIR}/789`]: "cached on disk" });
    const manager = newManager();

    await expect(manager.get("789")).resolves.toBe("cached on disk");
    await expect(manager.getStats()).resolves.toEqual({
      entryCount: 1,
      sizeBytes: 14,
    });
  });

  it("shares the cache between instances", async () => {
    const writer = newManager();
    await writer.set("42", "shared");

    const reader = newManager();
    await expect(reader.get("42")).resolves.toBe("shared");
  });

  it("forgets an entry whose file disappeared", async () => {
    vol.fromJSON({ [`${CACHE_DIR}/999`]: "transient" });
    const manager = newManager();
    await manager.getStats(); // wait for the index to be built

    vol.unlinkSync(`${CACHE_DIR}/999`);

    await expect(manager.get("999")).resolves.toBeNull();
    await expect(manager.getStats()).resolves.toEqual({
      entryCount: 0,
      sizeBytes: 0,
    });
  });

  it("evicts the oldest entries to stay under the size limit", async () => {
    const manager = newManager(10);

    await manager.set("a", "aaaaa");
    await manager.set("b", "bbbbb");
    await manager.set("c", "ccccc");

    const stats = await manager.getStats();
    expect(stats.sizeBytes).toBeLessThanOrEqual(10);
    expect(stats.entryCount).toBe(2);

    // The oldest entry is gone, the newest ones survive.
    await expect(manager.get("a")).resolves.toBeNull();
    await expect(manager.get("b")).resolves.toBe("bbbbb");
    await expect(manager.get("c")).resolves.toBe("ccccc");
    expect(vol.existsSync(`${CACHE_DIR}/a`)).toBe(false);
  });

  it("does not evict while under the limit", async () => {
    const manager = newManager(1000);

    for (const id of ["a", "b", "c"]) await manager.set(id, "small");

    await expect(manager.getStats()).resolves.toEqual({
      entryCount: 3,
      sizeBytes: 15,
    });
  });

  it("clears the cache", async () => {
    const manager = newManager();
    await manager.set("1", "content");

    await manager.clear();

    await expect(manager.getStats()).resolves.toEqual({
      entryCount: 0,
      sizeBytes: 0,
    });
    await expect(manager.get("1")).resolves.toBeNull();
    expect(vol.existsSync(`${CACHE_DIR}/1`)).toBe(false);
  });

  it("tolerates clearing an empty cache", async () => {
    const manager = newManager();

    await expect(manager.clear()).resolves.toBeUndefined();
    await expect(manager.getStats()).resolves.toEqual({
      entryCount: 0,
      sizeBytes: 0,
    });
  });
});
