import { beforeEach, describe, expect, it, vi } from "vitest";

// memfs-backed, see `__mocks__/fs/promises.cts`.
vi.mock("node:fs/promises");

import { vol } from "memfs";

import { calculateDbSize, fileExists, isFileNotFound } from "@main/platform/utils/fs";

describe("isFileNotFound", () => {
  it("detects ENOENT errors", () => {
    expect(isFileNotFound(Object.assign(new Error("nope"), { code: "ENOENT" }))).toBe(true);
    expect(isFileNotFound(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(false);
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
