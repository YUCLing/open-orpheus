import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

/**
 * Run `build` against a fresh temp staging dir, then move only the returned
 * artifact files into `outDir`. Every intermediate lives in the staging dir
 * and is removed afterwards, so the output dir contains only the artifacts.
 *
 * Returns the artifact paths in `outDir`.
 */
export async function makeInStaging(
  outDir: string,
  build: (staging: string) => Promise<string[]>
): Promise<string[]> {
  const staging = await mkdtemp(join(tmpdir(), "forge-make-"));
  try {
    const artifacts = await build(staging);
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
