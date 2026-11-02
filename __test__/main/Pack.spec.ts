import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import Pack from "../../src/main/packs/Pack";

/** `Pack` is abstract — this subclass only exposes the shared behaviour. */
class TestPack extends Pack {
  async readPack(): Promise<void> {
    this._isLoaded = true;
  }

  async readFile(path: string): Promise<Buffer> {
    return Buffer.from(path);
  }

  addFile(path: string, file: unknown) {
    this.files[this.normalizePath(path)] = file as never;
  }

  normalise(path: string) {
    return this.normalizePath(path);
  }
}

/** Host path of the pack file; unrelated to the POSIX entry names inside it. */
const PACK_PATH = resolve("tmp", "x.pack");

/**
 * ZIP entry names are always POSIX, independent of the host filesystem, so
 * these assertions intentionally use `/` rather than `path.sep`.
 */
describe("Pack.normalizePath", () => {
  const pack = new TestPack(PACK_PATH);

  it("prefixes a separator to relative paths", () => {
    expect(pack.normalise("a.txt")).toBe("/a.txt");
    expect(pack.normalise("a/b.txt")).toBe("/a/b.txt");
  });

  it("keeps absolute paths absolute", () => {
    expect(pack.normalise("/a/b.txt")).toBe("/a/b.txt");
  });

  it("normalises `.` and `..` segments", () => {
    expect(pack.normalise("a/./b.txt")).toBe("/a/b.txt");
    expect(pack.normalise("/a/b/../c.txt")).toBe("/a/c.txt");
  });
});

describe("Pack bookkeeping", () => {
  it("is empty and unloaded until readPack runs", async () => {
    const pack = new TestPack(PACK_PATH);

    expect(pack.isLoaded).toBe(false);
    expect(pack.fileList).toEqual([]);

    await pack.readPack();

    expect(pack.isLoaded).toBe(true);
  });

  it("indexes files by their normalised path", () => {
    const pack = new TestPack(PACK_PATH);
    pack.addFile("a.txt", { name: "a" });
    pack.addFile("/dir/b.txt", { name: "b" });

    expect(pack.fileList).toEqual(["/a.txt", "/dir/b.txt"]);
  });

  it("exposes the pack path to subclasses", async () => {
    await expect(new TestPack(PACK_PATH).readFile("a.txt")).resolves.toEqual(Buffer.from("a.txt"));
  });
});
