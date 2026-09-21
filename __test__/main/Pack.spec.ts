import { describe, expect, it } from "vitest";

import Pack from "@main/packs/Pack";

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

describe("Pack.normalizePath", () => {
  const pack = new TestPack("/tmp/x.pack");

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
    const pack = new TestPack("/tmp/x.pack");

    expect(pack.isLoaded).toBe(false);
    expect(pack.fileList).toEqual([]);

    await pack.readPack();

    expect(pack.isLoaded).toBe(true);
  });

  it("indexes files by their normalised path", () => {
    const pack = new TestPack("/tmp/x.pack");
    pack.addFile("a.txt", { name: "a" });
    pack.addFile("/dir/b.txt", { name: "b" });

    expect(pack.fileList).toEqual(["/a.txt", "/dir/b.txt"]);
  });

  it("exposes the pack path to subclasses", async () => {
    await expect(
      new TestPack("/tmp/x.pack").readFile("a.txt")
    ).resolves.toEqual(Buffer.from("a.txt"));
  });
});
