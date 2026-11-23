import { spawn, type SpawnOptions } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PROJECT_ROOT } from "../shared/paths.ts";
import { deployTarball } from "./lib/deps/pack.ts";
import {
  LEGACY_INDEX_NAME,
  lstatOrUndefined,
  restoreDependencies,
  SNAPSHOT_DIR_NAME,
  snapshotDirs,
} from "./lib/deps/snapshot.ts";

// Keep the public surface stable for tests and for callers that import the
// snapshot helpers directly.
export {
  captureDependency,
  readSnapshotEntries,
  restoreDependencies,
  snapshotDirs,
  type SnapshotDirs,
  type SnapshotEntry,
} from "./lib/deps/snapshot.ts";
export { deployTarball } from "./lib/deps/pack.ts";

const root = PROJECT_ROOT;

async function asyncSpawn(
  command: string,
  args: string[],
  options: SpawnOptions = {}
): Promise<void> {
  const opts = { ...options, cwd: root, shell: true, stdio: "inherit" } satisfies SpawnOptions;
  const proc = spawn(command, args, opts);
  return new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code !== 0) reject(code);
      resolve();
    });
  });
}

/**
 * v1 stored the snapshot in `index.json`, which this version ignores — the directory is the state
 * now, so its `absent` entries cannot be replayed. Warn rather than quietly mis-restoring.
 */
async function warnOnLegacySnapshot(dirs: ReturnType<typeof snapshotDirs>): Promise<void> {
  if (!(await lstatOrUndefined(resolve(dirs.snapshotDir, LEGACY_INDEX_NAME)))) return;
  console.warn(
    `[deploy-deps] ignoring the legacy ${LEGACY_INDEX_NAME} in ${SNAPSHOT_DIR_NAME}: the snapshot ` +
      "directory now holds the state. Delete it (or restore with the revision that wrote it) if " +
      "you are upgrading mid-deploy."
  );
}

async function main(): Promise<void> {
  const dirs = snapshotDirs(resolve(root, "node_modules"));
  await warnOnLegacySnapshot(dirs);

  if (process.argv.includes("--restore")) {
    const failures = await restoreDependencies(dirs);
    if (failures > 0) {
      console.error(`[deploy-deps] ${failures} snapshot entries could not be restored`);
      process.exitCode = 1;
    }
    return;
  }

  const packDir = await mkdtemp(join(tmpdir(), "pack-"));

  try {
    await asyncSpawn("pnpm", ["pack", "-r", "-F", '"./modules/*"', "--pack-destination", packDir]);

    const packs = (await readdir(packDir)).filter((name) => name.endsWith(".tgz"));
    for (const pack of packs) {
      await deployTarball(dirs, resolve(packDir, pack));
    }
  } finally {
    await rm(packDir, { recursive: true, force: true });
  }
}

// Only run as a CLI: importing this module (e.g. from tests) must not deploy anything.
if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      `[deploy-deps] ${error instanceof Error ? error.message : `exit code ${String(error)}`}`
    );
    console.error(
      "[deploy-deps] hint: run `node tools/scripts/deploy-deps.ts --restore` to put node_modules back."
    );
    process.exitCode = 1;
  }
}
