import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

// `folders.ts` only reads Electron's paths, so no fs mock is needed here.
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn((name: string) => `/tmp/open-orpheus-test/${name}`),
  },
  BrowserWindow: vi.fn(),
  screen: { getDisplayMatching: vi.fn() },
}));

import {
  cache,
  data,
  defaultCache,
  disableHardwareAccelerationFlag,
  download,
  downloadTemp,
  lastWebpackHash,
  log,
  pack,
  setCachePath,
  setDownloadPath,
  storage,
  streamerTemp,
  userdata,
  wasm,
} from "@main/platform/folders";

describe("folders", () => {
  it("derives the temp directories from the OS temp path", () => {
    expect(downloadTemp).toBe(
      join("/tmp/open-orpheus-test/temp", "open-orpheus-download-temp")
    );
    expect(streamerTemp).toBe(
      join("/tmp/open-orpheus-test/temp", "open-orpheus-streamer-temp")
    );
  });

  it("uses the repository data directory while unpackaged", () => {
    expect(data).toBe(resolve("data"));
  });

  it("derives the data sub-directories", () => {
    for (const sub of [log, pack, userdata, storage, wasm, defaultCache]) {
      expect(sub.startsWith(data + "/")).toBe(true);
    }
    expect(log).toBe(join(data, "logs"));
    expect(pack).toBe(join(data, "package"));
    expect(userdata).toBe(join(data, "userdata"));
    expect(storage).toBe(join(data, "storage"));
    expect(wasm).toBe(join(data, "wasm"));
    expect(defaultCache).toBe(join(data, "cache"));
  });

  it("derives the flag and state files", () => {
    expect(disableHardwareAccelerationFlag).toBe(
      join(data, "disable-hw-accel")
    );
    expect(lastWebpackHash).toBe(join(data, "last-webpack-hash"));
  });

  it("starts on the default cache path with no download path", () => {
    expect(cache).toBe(defaultCache);
    expect(download).toBe("");
  });

  it("switches the cache and download paths", () => {
    setCachePath("/mnt/media/cache");
    setDownloadPath("/mnt/media/downloads");

    expect(cache).toBe("/mnt/media/cache");
    expect(download).toBe("/mnt/media/downloads");

    setCachePath(defaultCache);
    setDownloadPath("");
  });
});
