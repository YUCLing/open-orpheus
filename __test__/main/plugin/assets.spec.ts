import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolvePluginAssetTarget } from "../../../src/main/plugin/assets";

let root: string | null = null;

async function createRoot(): Promise<string> {
  root = await mkdtemp(path.join(tmpdir(), "open-orpheus-assets-"));
  await mkdir(path.join(root, "assets"), { recursive: true });
  await writeFile(path.join(root, "assets", "ok.png"), "ok");
  await writeFile(path.join(root, "secret.txt"), "secret");
  return root;
}

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = null;
  }
});

describe("resolvePluginAssetTarget", () => {
  it("resolves a normal asset", async () => {
    const directory = await createRoot();

    await expect(resolvePluginAssetTarget(directory, "ok.png")).resolves.toBe(
      path.join(directory, "assets", "ok.png")
    );
  });

  it("rejects lexical escapes", async () => {
    const directory = await createRoot();

    await expect(resolvePluginAssetTarget(directory, "../secret.txt")).resolves.toBeNull();
  });

  it.skipIf(process.platform === "win32")("rejects symlink escapes", async () => {
    const directory = await createRoot();
    await symlink(path.join(directory, "secret.txt"), path.join(directory, "assets", "escape.txt"));

    await expect(resolvePluginAssetTarget(directory, "escape.txt")).resolves.toBeNull();
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked assets directory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "open-orpheus-assets-"));
    root = directory;
    await mkdir(path.join(directory, "outside"), { recursive: true });
    await writeFile(path.join(directory, "outside", "secret.txt"), "secret");
    await symlink(path.join(directory, "outside"), path.join(directory, "assets"));

    await expect(resolvePluginAssetTarget(directory, "secret.txt")).resolves.toBeNull();
  });
});
