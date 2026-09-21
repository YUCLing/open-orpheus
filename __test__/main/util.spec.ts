import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// memfs-backed, see `__mocks__/fs/promises.cts`.
vi.mock("node:fs/promises");
vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  screen: { getDisplayMatching: vi.fn(() => ({ scaleFactor: 2 })) },
}));

import { vol } from "memfs";

import type { MetaPicture } from "music-tag-native";

import {
  calculateDbSize,
  checkEnvFlagPresent,
  fileExists,
  getWindowScaleFactor,
  isFileNotFound,
  isMusicFile,
  normalizePath,
  sanitizeRelativePath,
  selectBestMusicPic,
} from "@main/util";

const onPosix = process.platform !== "win32";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.runIf(onPosix)("normalizePath", () => {
  it("normalises posix paths", () => {
    expect(normalizePath("/a/b", "c/d")).toBe("/a/b/c/d");
    expect(normalizePath("/a", "b/../c")).toBe("/a/c");
  });

  it("converts windows separators on other platforms", () => {
    expect(normalizePath("/a", "b\\c")).toBe("/a/b/c");
  });
});

describe.runIf(onPosix)("sanitizeRelativePath", () => {
  it("resolves paths inside the base directory", () => {
    expect(sanitizeRelativePath("/base", "sub/file.txt")).toBe(
      "/base/sub/file.txt"
    );
    expect(sanitizeRelativePath("/base", "a/../b.txt")).toBe("/base/b.txt");
    expect(sanitizeRelativePath("/base", "sub\\file.txt")).toBe(
      "/base/sub/file.txt"
    );
  });

  it("resolves the base directory itself", () => {
    expect(sanitizeRelativePath("/base", ".")).toBe("/base");
    expect(sanitizeRelativePath("/base", "")).toBe("/base");
  });

  it("rejects path traversal", () => {
    expect(sanitizeRelativePath("/base", "../other")).toBe(false);
    expect(sanitizeRelativePath("/base", "../../etc/passwd")).toBe(false);
    expect(sanitizeRelativePath("/base", "sub/../../other")).toBe(false);
  });

  it("rejects siblings sharing the base prefix", () => {
    expect(sanitizeRelativePath("/base", "../base-evil/x")).toBe(false);
  });
});

describe("isFileNotFound", () => {
  it("detects ENOENT errors", () => {
    expect(
      isFileNotFound(Object.assign(new Error("nope"), { code: "ENOENT" }))
    ).toBe(true);
    expect(
      isFileNotFound(Object.assign(new Error("denied"), { code: "EACCES" }))
    ).toBe(false);
    expect(isFileNotFound(new Error("nope"))).toBe(false);
    expect(isFileNotFound("nope")).toBe(false);
    expect(isFileNotFound(null)).toBe(false);
  });
});

describe("fileExists", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("returns true for an existing file", async () => {
    vol.fromJSON({ "/a/b.txt": "hi" });
    await expect(fileExists("/a/b.txt")).resolves.toBe(true);
  });

  it("returns false for a missing file", async () => {
    await expect(fileExists("/a/missing.txt")).resolves.toBe(false);
  });

  it("re-raises errors other than ENOENT", async () => {
    const error = Object.assign(new Error("denied"), { code: "EACCES" });
    vi.spyOn(vol.promises, "access").mockRejectedValueOnce(error);

    await expect(fileExists("/a/b.txt")).rejects.toThrow("denied");
  });
});

describe("calculateDbSize", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("adds up the database, WAL and SHM files", async () => {
    vol.fromJSON({
      "/db/main.db": "a".repeat(10),
      "/db/main.db-wal": "b".repeat(20),
      "/db/main.db-shm": "c".repeat(30),
    });

    await expect(calculateDbSize("/db/main.db")).resolves.toBe(60);
  });

  it("ignores missing sidecar files", async () => {
    vol.fromJSON({ "/db/main.db": "a".repeat(7) });

    await expect(calculateDbSize("/db/main.db")).resolves.toBe(7);
  });

  it("rejects when the database itself is missing", async () => {
    await expect(calculateDbSize("/db/missing.db")).rejects.toThrow();
  });
});

describe("selectBestMusicPic", () => {
  const pic = (coverType: string) => ({ coverType }) as MetaPicture;

  it("prefers the front cover", () => {
    const front = pic("Cover Art (Front)");
    expect(
      selectBestMusicPic([pic("Cover Art (Back)"), front, pic("Other")])
    ).toBe(front);
  });

  it("falls back to the first picture", () => {
    const first = pic("Other");
    expect(selectBestMusicPic([first, pic("Back")])).toBe(first);
  });

  it("returns null when there are no pictures", () => {
    expect(selectBestMusicPic([])).toBeNull();
  });
});

describe("checkEnvFlagPresent", () => {
  it("accepts `1` and `true`", () => {
    vi.stubEnv("ORPHEUS_TEST_FLAG", "1");
    expect(checkEnvFlagPresent("ORPHEUS_TEST_FLAG")).toBe(true);

    vi.stubEnv("ORPHEUS_TEST_FLAG", "true");
    expect(checkEnvFlagPresent("ORPHEUS_TEST_FLAG")).toBe(true);
  });

  it("rejects other values and unset variables", () => {
    vi.stubEnv("ORPHEUS_TEST_FLAG", "0");
    expect(checkEnvFlagPresent("ORPHEUS_TEST_FLAG")).toBe(false);

    vi.stubEnv("ORPHEUS_TEST_FLAG", "yes");
    expect(checkEnvFlagPresent("ORPHEUS_TEST_FLAG")).toBe(false);

    expect(checkEnvFlagPresent("ORPHEUS_UNSET_FLAG")).toBe(false);
  });
});

describe("isMusicFile", () => {
  it("recognises audio mime types", () => {
    expect(isMusicFile("song.mp3")).toBe(true);
    expect(isMusicFile("/music/track.flac")).toBe(true);
    expect(isMusicFile("recording.wav")).toBe(true);
  });

  it("rejects non-audio files", () => {
    expect(isMusicFile("cover.jpg")).toBe(false);
    expect(isMusicFile("notes.txt")).toBe(false);
    expect(isMusicFile("no-extension")).toBe(false);
  });
});

describe("getWindowScaleFactor", () => {
  it("reports the scale factor of the matching display", () => {
    const wnd = { getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) };
    expect(getWindowScaleFactor(wnd as never)).toBe(2);
  });
});
