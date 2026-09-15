import { tmpdir } from "node:os";

import { beforeEach, describe, expect, it, vi } from "vitest";

// memfs-backed, see `__mocks__/fs/promises.cts`.
vi.mock("node:fs/promises");

import { mkdir, readFile, writeFile } from "node:fs/promises";

import { vol } from "memfs";

import { makeInStaging } from "../../packaging/common/maker";

/** A build callback that drops `files` into the staging dir and returns them. */
function buildWith(files: Record<string, string>) {
  return vi.fn(async (staging: string) => {
    await mkdir(staging, { recursive: true });
    const artifacts: string[] = [];
    for (const [name, content] of Object.entries(files)) {
      const path = `${staging}/${name}`;
      await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      await writeFile(path, content);
      artifacts.push(path);
    }
    return artifacts;
  });
}

beforeEach(() => {
  vol.reset();
  // memfs starts empty, and `mkdtemp` needs its parent to exist.
  vol.mkdirSync(tmpdir(), { recursive: true });
});

describe("makeInStaging", () => {
  it("moves the artifacts into the output directory", async () => {
    const build = buildWith({ "app.deb": "deb-bytes" });

    const artifacts = await makeInStaging("/out/deb", build);

    expect(artifacts).toEqual(["/out/deb/app.deb"]);
    await expect(readFile("/out/deb/app.deb", "utf-8")).resolves.toBe(
      "deb-bytes"
    );
  });

  it("builds in a temp staging directory and removes it afterwards", async () => {
    const build = buildWith({ "app.deb": "x" });

    await makeInStaging("/out/deb", build);

    const staging = build.mock.calls[0][0];
    expect(staging.startsWith(tmpdir())).toBe(true);
    expect(staging).toContain("forge-make-");
    expect(vol.existsSync(staging)).toBe(false);
  });

  it("uses a fresh staging directory per run", async () => {
    const build = buildWith({ "app.deb": "x" });

    await makeInStaging("/out/deb", build);
    await makeInStaging("/out/deb", build);

    const [first, second] = build.mock.calls.map(([staging]) => staging);
    expect(first).not.toBe(second);
  });

  it("empties the output directory by default", async () => {
    vol.fromJSON({ "/out/deb/stale.deb": "old" });
    const build = buildWith({ "app.deb": "new" });

    await makeInStaging("/out/deb", build);

    expect(vol.existsSync("/out/deb/stale.deb")).toBe(false);
    expect(vol.existsSync("/out/deb/app.deb")).toBe(true);
  });

  it("keeps previous artifacts when clean is false", async () => {
    vol.fromJSON({ "/out/deb/stale.deb": "old" });
    const build = buildWith({ "app.deb": "new" });

    await makeInStaging("/out/deb", build, false);

    await expect(readFile("/out/deb/stale.deb", "utf-8")).resolves.toBe("old");
    expect(vol.existsSync("/out/deb/app.deb")).toBe(true);
  });

  it("flattens nested artifact paths", async () => {
    const build = buildWith({ "nested/dir/app.deb": "nested" });

    const artifacts = await makeInStaging("/out/deb", build);

    expect(artifacts).toEqual(["/out/deb/app.deb"]);
    await expect(readFile("/out/deb/app.deb", "utf-8")).resolves.toBe("nested");
  });

  it("returns every artifact", async () => {
    const build = buildWith({ "a.deb": "a", "b.deb": "b" });

    const artifacts = await makeInStaging("/out/deb", build);

    expect(artifacts.sort()).toEqual(["/out/deb/a.deb", "/out/deb/b.deb"]);
  });

  it("propagates build failures but still cleans up staging", async () => {
    const build = vi.fn(async (staging: string) => {
      await mkdir(staging, { recursive: true });
      throw new Error("build exploded");
    });

    await expect(makeInStaging("/out/deb", build)).rejects.toThrow(
      "build exploded"
    );
    expect(vol.existsSync(build.mock.calls[0][0])).toBe(false);
  });
});
