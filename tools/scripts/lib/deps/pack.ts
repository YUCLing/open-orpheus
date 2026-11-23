import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { extract, list } from "tar";

import { captureDependency, type SnapshotDirs } from "./snapshot.ts";

const PACKAGE_PREFIX = "package/";

/** Mirrors npm's `os` field semantics: positives are an allow-list, `!value` a deny-list. */
function isPlatformCompatible(os?: string[]): boolean {
  if (!os || os.length === 0) return true;
  if (os.some((value) => value.startsWith("!") && value.slice(1) === process.platform)) {
    return false;
  }
  const positives = os.filter((value) => !value.startsWith("!"));
  return positives.length === 0 || positives.includes(process.platform);
}

/** Read the `package/package.json` manifest from a packed module tarball. */
async function readPackedManifest(tarball: string): Promise<{ name: string; os?: string[] }> {
  const chunks: Buffer[] = [];
  await list({
    file: tarball,
    filter: (path) => path === `${PACKAGE_PREFIX}package.json`,
    onReadEntry: (entry) => {
      entry.on("data", (chunk: Buffer) => chunks.push(chunk));
    },
  });
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as { name: string; os?: string[] };
}

/**
 * Extract a packed module tarball (as produced by `pnpm pack`) directly into `node_modules`,
 * replacing the workspace symlink with the deployed files. The replaced entry is captured first,
 * so it can be restored later.
 */
export async function deployTarball(dirs: SnapshotDirs, tarball: string): Promise<void> {
  const pkg = await readPackedManifest(tarball);
  const entry = await captureDependency(dirs, pkg.name);

  if (entry.kind === "directory") {
    console.warn(
      `[deploy-deps] ${pkg.name} was a real directory, not a workspace link; run \`pnpm install\` ` +
        "first if the snapshot should capture the link instead."
    );
  }

  // Modules that don't apply to the current platform (e.g. win32-only on Linux) are not
  // extracted, but their existing link/folder was still moved aside above.
  if (!isPlatformCompatible(pkg.os)) return;

  const dest = resolve(dirs.nodeModulesDir, pkg.name);
  await mkdir(dest, { recursive: true });

  // `strip: 1` drops the leading `package/` directory from every entry.
  await extract({ file: tarball, cwd: dest, strip: 1 });
}
