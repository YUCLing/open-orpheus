import { join, resolve, sep } from "node:path";

import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const path = process.getBuiltinModule("node:path");
  const os = process.getBuiltinModule("node:os");
  const testRoot = path.resolve(os.tmpdir(), "open-orpheus-test");
  return {
    testRoot,
    getPath: (name: string) => path.join(testRoot, name),
  };
});

/** Host-native stand-in for the paths Electron would report. */
const temp = join(hoisted.testRoot, "temp");

// `folders.ts` only reads Electron's paths, so no fs mock is needed here.
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: hoisted.getPath,
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
} from "../../src/main/folders";

describe("folders", () => {
  it("derives the temp directories from the OS temp path", () => {
    const tempDir = join(temp, "open-orpheus-temp");
    expect(downloadTemp).toBe(join(tempDir, "download"));
    expect(streamerTemp).toBe(join(tempDir, "streamer"));
  });

  it("uses the repository data directory while unpackaged", () => {
    expect(data).toBe(resolve("data"));
  });

  it("derives the data sub-directories", () => {
    for (const sub of [log, pack, userdata, storage, wasm, defaultCache]) {
      expect(sub.startsWith(data + sep)).toBe(true);
    }
    expect(log).toBe(join(data, "logs"));
    expect(pack).toBe(join(data, "package"));
    expect(userdata).toBe(join(data, "userdata"));
    expect(storage).toBe(join(data, "storage"));
    expect(wasm).toBe(join(data, "wasm"));
    expect(defaultCache).toBe(join(data, "cache"));
  });

  it("derives the flag and state files", () => {
    expect(disableHardwareAccelerationFlag).toBe(join(data, "disable-hw-accel"));
    expect(lastWebpackHash).toBe(join(data, "last-webpack-hash"));
  });

  it("starts on the default cache path with no download path", () => {
    expect(cache).toBe(defaultCache);
    expect(download).toBe("");
  });

  it("switches the cache and download paths", () => {
    const cachePath = resolve("mnt", "media", "cache");
    const downloadPath = resolve("mnt", "media", "downloads");

    setCachePath(cachePath);
    setDownloadPath(downloadPath);

    expect(cache).toBe(cachePath);
    expect(download).toBe(downloadPath);

    setCachePath(defaultCache);
    setDownloadPath("");
  });
});
