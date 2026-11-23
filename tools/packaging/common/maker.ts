import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { cleanOutDir } from "./util.ts";

/**
 * Run `build` against a fresh temp staging dir, then move only the returned
 * artifact files into `outDir` (emptied first unless `clean` is false, so stale
 * artifacts from earlier runs are never left behind). Every intermediate lives
 * in the staging dir and is removed afterwards, so the output dir contains only
 * the artifacts.
 *
 * Returns the artifact paths in `outDir`.
 */
export async function makeInStaging(
  outDir: string,
  build: (staging: string) => Promise<string[]>,
  clean = true
): Promise<string[]> {
  const staging = await mkdtemp(join(tmpdir(), "forge-make-"));
  try {
    const artifacts = await build(staging);
    await cleanOutDir(outDir, clean);
    await mkdir(outDir, { recursive: true });
    const moved: string[] = [];
    for (const artifact of artifacts) {
      const dest = resolve(outDir, basename(artifact));
      // copyFile (not rename): tmp is often on a different mount than outDir.
      await copyFile(artifact, dest);
      moved.push(dest);
    }
    return moved;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
