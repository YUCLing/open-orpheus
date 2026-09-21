import { beforeEach, describe, expect, it, vi } from "vitest";

// memfs-backed, see `__mocks__/fs/promises.cts`.
vi.mock("node:fs/promises");

const hoisted = vi.hoisted(() => ({ send: vi.fn() }));

import type { MainWindowAccessor } from "@main/bootstrap/types";

import { readFile } from "node:fs/promises";

import { vol } from "memfs";

import PlayCacheManager, {
  type CacheTrackMeta,
} from "@main/cache/PlayCacheManager";

const CACHE_PATH = "/cache/play";
const MiB = 1024 * 1024;

const windows: MainWindowAccessor = {
  current: () => ({ webContents: { send: hoisted.send } }),
};

function manager() {
  return new PlayCacheManager(CACHE_PATH, windows);
}

function meta(songId: string, fileSize = MiB): CacheTrackMeta {
  return {
    bitrate: 320000,
    cached: 100,
    dfsId: "",
    format: "mp3",
    lastAccessTime: 1,
    lastModifyTime: 1,
    md5: "md5",
    playInfoExist: true,
    playInfoStr: "{}",
    songId,
    volumeGain: 0,
    fileSize,
  };
}

const trackInfo = {
  md5: "md5",
  bitrate: 320000,
  playInfoStr: '{"id":1}',
  volumeGain: -2.5,
  fileSize: MiB,
};

/** The update type the manager reports: 1 = cached, 2 = removed. */
function notifications() {
  return hoisted.send.mock.calls
    .filter(
      ([channel, command]) =>
        channel === "channel.call" && command === "storage.onPlayCacheUpdate"
    )
    .map(
      ([, , payload]) =>
        payload as { songId: string; playCacheUpdateType: number }
    );
}

beforeEach(() => {
  vol.reset();
  hoisted.send.mockReset();
});

describe("PlayCacheManager index", () => {
  it("starts empty", async () => {
    const cache = manager();

    await expect(cache.queryCacheTracks()).resolves.toEqual([]);
  });

  it("indexes the cache directories found on disk", async () => {
    vol.fromJSON({
      [`${CACHE_PATH}/123/meta.json`]: JSON.stringify(meta("123")),
      [`${CACHE_PATH}/456/meta.json`]: JSON.stringify(meta("456", 2 * MiB)),
      [`${CACHE_PATH}/loose.txt`]: "not a directory",
    });

    const tracks = await manager().queryCacheTracks();

    expect(tracks.map((t) => t.songId).sort()).toEqual(["123", "456"]);
  });

  it("skips corrupt metadata", async () => {
    vol.fromJSON({
      [`${CACHE_PATH}/123/meta.json`]: JSON.stringify(meta("123")),
      [`${CACHE_PATH}/999/meta.json`]: "{ not json",
      [`${CACHE_PATH}/888/audio`]: "no meta at all",
    });

    await expect(manager().queryCacheTracks()).resolves.toEqual([meta("123")]);
  });
});

describe("PlayCacheManager.cacheTrack", () => {
  it("writes the audio and metadata, then indexes the track", async () => {
    const cache = manager();

    await cache.cacheTrack("123", Buffer.from("audio-bytes"), trackInfo);

    await expect(readFile(`${CACHE_PATH}/123/audio`, "utf-8")).resolves.toBe(
      "audio-bytes"
    );
    const stored = JSON.parse(
      await readFile(`${CACHE_PATH}/123/meta.json`, "utf-8")
    );
    expect(stored).toMatchObject({
      songId: "123",
      md5: "md5",
      bitrate: 320000,
      playInfoStr: '{"id":1}',
      volumeGain: -2.5,
      fileSize: MiB,
      cached: 100,
      playInfoExist: true,
    });
    expect(stored.lastAccessTime).toEqual(expect.any(Number));

    await expect(cache.queryCacheTracks()).resolves.toEqual([
      expect.objectContaining({ songId: "123" }),
    ]);
  });

  it("notifies the frontend with an update of type 1", async () => {
    await manager().cacheTrack("123", Buffer.from("audio"), trackInfo);

    expect(notifications()).toEqual([
      expect.objectContaining({ songId: "123", playCacheUpdateType: 1 }),
    ]);
    expect(hoisted.send).toHaveBeenCalledWith(
      "channel.call",
      "storage.onPlayCacheUpdate",
      expect.objectContaining({ songId: "123" })
    );
  });
});

describe("PlayCacheManager.getCachedTrack", () => {
  it("returns the metadata and the audio path", async () => {
    const cache = manager();
    await cache.cacheTrack("123", Buffer.from("audio"), trackInfo);

    const cached = await cache.getCachedTrack("123");

    expect(cached?.audioPath).toBe(`${CACHE_PATH}/123/audio`);
    expect(cached?.meta).toMatchObject({ songId: "123", md5: "md5" });
  });

  it("refreshes the access time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const cache = manager();
      await cache.cacheTrack("123", Buffer.from("audio"), trackInfo);
      const cachedAt = (await cache.getCachedTrack("123"))!.meta.lastAccessTime;

      vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
      const later = await cache.getCachedTrack("123");

      expect(later!.meta.lastAccessTime).toBe(cachedAt + 60);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns null for a song that is not cached", async () => {
    await expect(manager().getCachedTrack("nope")).resolves.toBeNull();
  });

  it("forgets a track whose audio file disappeared", async () => {
    const cache = manager();
    await cache.cacheTrack("123", Buffer.from("audio"), trackInfo);
    vol.rmSync(`${CACHE_PATH}/123`, { recursive: true, force: true });

    await expect(cache.getCachedTrack("123")).resolves.toBeNull();
    await expect(cache.queryCacheTracks()).resolves.toEqual([]);
  });
});

describe("PlayCacheManager.getInfo", () => {
  it("falls back to the documented defaults", async () => {
    const info = await manager().getInfo();

    expect(info).toMatchObject({
      ABName: "PH-PC-Cache-Switch",
      groupName: "t1",
      autoCacheSize: 1,
      autoCacheSizeReal: 1,
      clearLimitMax: 10,
      clearToLimit: 8,
      settingLowLimit: 10,
      settingUpLimit: 50,
      userSettingSize: 10,
      userSettingSizeReal: 10,
      manuSetting: false,
      configJson: "",
      cachePath: CACHE_PATH,
      currentCachedSize: 0,
    });
    expect(info.diskFreeSize).toBeGreaterThanOrEqual(0);
  });

  it("reflects the configured limits and flags", async () => {
    const cache = manager();
    cache.setConfig({
      ABName: "Custom-AB",
      autoCacheSize: "3",
      configJson: '{"a":1}',
      groupName: "group",
      manuSetting: "true",
      settingLowLimit: "5",
      settingUpLimit: "40",
      userSettingSize: "20",
    });

    await expect(cache.getInfo()).resolves.toMatchObject({
      ABName: "Custom-AB",
      groupName: "group",
      autoCacheSize: 3,
      clearLimitMax: 20,
      clearToLimit: 16,
      settingLowLimit: 5,
      settingUpLimit: 40,
      userSettingSize: 20,
      userSettingSizeReal: 20,
      manuSetting: true,
      configJson: '{"a":1}',
    });
  });

  it("reports the cached size from the index", async () => {
    const cache = manager();
    await cache.cacheTrack("1", Buffer.from("a"), {
      ...trackInfo,
      fileSize: MiB,
    });
    await cache.cacheTrack("2", Buffer.from("b"), {
      ...trackInfo,
      fileSize: MiB,
    });

    const info = await cache.getInfo();

    expect(info.currentCachedSize).toBeCloseTo((2 * MiB) / 1024 ** 3, 10);
  });
});

describe("PlayCacheManager eviction", () => {
  it("removes the oldest tracks when the cache is over the limit", async () => {
    const cache = manager();
    cache.setConfig({
      ABName: "AB",
      autoCacheSize: "1",
      configJson: "{}",
      groupName: "g",
      manuSetting: false,
      settingLowLimit: "0",
      settingUpLimit: "0",
      userSettingSize: "0",
    });

    await cache.cacheTrack("old", Buffer.from("a"), trackInfo);
    await cache.cacheTrack("new", Buffer.from("b"), trackInfo);

    await expect(cache.queryCacheTracks()).resolves.toEqual([]);
    expect(vol.existsSync(`${CACHE_PATH}/old`)).toBe(false);
    expect(notifications().filter((n) => n.playCacheUpdateType === 2)).toEqual([
      expect.objectContaining({ songId: "old" }),
      expect.objectContaining({ songId: "new" }),
    ]);
  });

  it("keeps everything while under the limit", async () => {
    const cache = manager();
    cache.setConfig({
      ABName: "AB",
      autoCacheSize: "1",
      configJson: "{}",
      groupName: "g",
      manuSetting: false,
      settingLowLimit: "10",
      settingUpLimit: "50",
      userSettingSize: "10",
    });

    await cache.cacheTrack("1", Buffer.from("a"), trackInfo);

    await expect(cache.queryCacheTracks()).resolves.toHaveLength(1);
    expect(notifications().some((n) => n.playCacheUpdateType === 2)).toBe(
      false
    );
  });
});

describe("PlayCacheManager.clearAll", () => {
  it("removes the cache directory and notifies the removal of every track", async () => {
    const cache = manager();
    await cache.cacheTrack("1", Buffer.from("a"), trackInfo);
    await cache.cacheTrack("2", Buffer.from("b"), trackInfo);
    hoisted.send.mockClear();

    await cache.clearAll();

    expect(vol.existsSync(CACHE_PATH)).toBe(false);
    await expect(cache.queryCacheTracks()).resolves.toEqual([]);
    expect(notifications()).toEqual([
      expect.objectContaining({ songId: "1", playCacheUpdateType: 2 }),
      expect.objectContaining({ songId: "2", playCacheUpdateType: 2 }),
    ]);
  });

  it("tolerates an already empty cache", async () => {
    const cache = manager();

    await expect(cache.clearAll()).resolves.toBeUndefined();
    await expect(cache.queryCacheTracks()).resolves.toEqual([]);
  });
});
