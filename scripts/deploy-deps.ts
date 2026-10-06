import { spawn, type SpawnOptions } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { lstat, mkdir, mkdtemp, readdir, readlink, rename, rm, writeFile } from "node:fs/promises";
import { extract, list } from "tar";

const root = resolve(import.meta.dirname, "..");

const PACKAGE_PREFIX = "package/";

const SNAPSHOT_DIR_NAME = ".dep-snapshot";
/** Holds the markers for dependencies that did not exist before the deploy. */
const ABSENT_DIR_NAME = ".absent";
/** v1 kept the snapshot state here; the directory is authoritative now. */
const LEGACY_INDEX_NAME = "index.json";

type SnapshotEntryKind = "symlink" | "directory" | "file" | "absent";

/** The subset of `Stats`/`Dirent` this script classifies. */
type SnapshotDirent = { isSymbolicLink(): boolean; isDirectory(): boolean };

export interface SnapshotEntry {
  /** Path relative to `node_modules`, using `/` separators (e.g. `@open-orpheus/av3a`). */
  path: string;
  /** What sat at that path before the first deploy. */
  kind: SnapshotEntryKind;
  /** `readlink` result, recorded for symlinks only. */
  target?: string;
}

/** Where a snapshot lives. Passed in so the logic can run against a temporary tree. */
export interface SnapshotDirs {
  /** The `node_modules` directory deployments write into. */
  nodeModulesDir: string;
  /** The snapshot directory inside it. */
  snapshotDir: string;
}

/** The snapshot directories belonging to a `node_modules` root. */
export function snapshotDirs(nodeModulesDir: string): SnapshotDirs {
  return { nodeModulesDir, snapshotDir: resolve(nodeModulesDir, SNAPSHOT_DIR_NAME) };
}

const livePath = (dirs: SnapshotDirs, name: string) => resolve(dirs.nodeModulesDir, name);
const payloadPath = (dirs: SnapshotDirs, name: string) => resolve(dirs.snapshotDir, name);
const absentPath = (dirs: SnapshotDirs, name: string) =>
  resolve(dirs.snapshotDir, ABSENT_DIR_NAME, name);

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

// --- Dependency snapshot --------------------------------------------------------------------
//
// Deployment replaces the `node_modules` links of our workspace modules with packed copies.
// Instead of deleting the replaced entries, they are moved into `node_modules/.dep-snapshot`, so
// `deploy-deps.ts --restore` can put the working tree back exactly as it was.
//
// The snapshot directory is the *only* state, and each captured dependency is exactly one entry:
//
//   `.dep-snapshot/<name>`           the original (symlink, directory or file)
//   `.dep-snapshot/.absent/<name>`   a marker meaning "nothing existed at <name>"
//
// So capturing is one atomic operation (a `rename`, or writing a marker), an interrupted capture
// is indistinguishable from a completed one, and any state is readable from the directory alone —
// there is no second record that can disagree with it. `--restore` consumes entries back into
// `node_modules` and drops the directory once nothing is left in it.

/** `lstat` that only treats ENOENT as "missing"; every other error is real and propagates. */
async function lstatOrUndefined(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

/**
 * Reject names that could escape `node_modules` or `node_modules/.dep-snapshot`. Dot-prefixed
 * names are refused too: the snapshot stores them under `.absent/`, so a package named e.g.
 * `.absent` would collide with the state that marks dependencies as missing.
 */
function assertSafePackageName(name: string): void {
  const segments = name.split("/");
  if (
    name.length === 0 ||
    name.startsWith(".") ||
    name.includes("\\") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe package name: ${JSON.stringify(name)}`);
  }
}

/**
 * Describe what sits at `path` (named `name` in the snapshot). Symlinks keep their target, so an
 * entry read back from the directory restores exactly like the one that was captured.
 */
async function describeEntry(
  path: string,
  name: string,
  dirent: SnapshotDirent
): Promise<SnapshotEntry> {
  if (dirent.isSymbolicLink()) {
    return { path: name, kind: "symlink", target: await readlink(path) };
  }
  if (dirent.isDirectory()) return { path: name, kind: "directory" };
  return { path: name, kind: "file" };
}

/**
 * Move `node_modules/<name>` aside — or record that nothing was there — so the deployment can take
 * its place.
 *
 * Repeating a deploy is safe: an existing entry *is* the pre-deploy state, so the current `live`
 * path can only be a previous deployment and is simply cleared. There is no record to go stale,
 * because the entry and the state are the same thing.
 */
export async function captureDependency(dirs: SnapshotDirs, name: string): Promise<SnapshotEntry> {
  assertSafePackageName(name);

  const live = livePath(dirs, name);
  const payload = payloadPath(dirs, name);
  const marker = absentPath(dirs, name);

  const payloadStats = await lstatOrUndefined(payload);
  const markerStats = payloadStats ? undefined : await lstatOrUndefined(marker);

  if (payloadStats || markerStats) {
    const entry: SnapshotEntry = payloadStats
      ? await describeEntry(payload, name, payloadStats)
      : { path: name, kind: "absent" };
    // Keep the snapshot as it is and clear whatever the previous deploy left behind.
    await rm(live, { recursive: true, force: true });
    console.log(`[deploy-deps] kept snapshot: ${name} (${entry.kind})`);
    return entry;
  }

  const liveStats = await lstatOrUndefined(live);
  if (!liveStats) {
    // Nothing to preserve, but `--restore` must still know the path has to end up empty.
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, "");
    console.log(`[deploy-deps] snapshot: ${name} (absent)`);
    return { path: name, kind: "absent" };
  }

  await mkdir(dirname(payload), { recursive: true });
  // `rename` moves the entry itself, so a symlink keeps pointing where it did.
  await rename(live, payload);
  const entry = await describeEntry(payload, name, liveStats);
  console.log(`[deploy-deps] snapshot: ${name} (${entry.kind})`);
  return entry;
}

/**
 * Read the snapshot directory: every payload and every `absent` marker, described from the
 * filesystem alone. A legacy `index.json` (v1) is skipped — it is not a captured dependency.
 */
export async function readSnapshotEntries(dirs: SnapshotDirs): Promise<SnapshotEntry[]> {
  const entries: SnapshotEntry[] = [];

  for (const child of await readdir(dirs.snapshotDir, { withFileTypes: true })) {
    // Skip `.absent/` and a legacy v1 `index.json` file; either can only be bookkeeping.
    if (child.name.startsWith(".") || (child.name === LEGACY_INDEX_NAME && child.isFile())) {
      continue;
    }

    if (child.isDirectory() && child.name.startsWith("@")) {
      const packages = await readdir(resolve(dirs.snapshotDir, child.name), {
        withFileTypes: true,
      });
      for (const pkg of packages) {
        const path = `${child.name}/${pkg.name}`;
        entries.push(await describeEntry(resolve(dirs.snapshotDir, path), path, pkg));
      }
      continue;
    }

    entries.push(await describeEntry(resolve(dirs.snapshotDir, child.name), child.name, child));
  }

  const absentDir = resolve(dirs.snapshotDir, ABSENT_DIR_NAME);
  if (!(await lstatOrUndefined(absentDir))) return entries;

  for (const child of await readdir(absentDir, { withFileTypes: true })) {
    if (child.isDirectory() && child.name.startsWith("@")) {
      const packages = await readdir(resolve(absentDir, child.name), { withFileTypes: true });
      for (const pkg of packages) {
        entries.push({ path: `${child.name}/${pkg.name}`, kind: "absent" });
      }
      continue;
    }

    entries.push({ path: child.name, kind: "absent" });
  }

  return entries;
}

/** Put a single snapshot entry back and consume it. Throws on failure; the caller keeps it. */
async function restoreEntry(dirs: SnapshotDirs, entry: SnapshotEntry): Promise<void> {
  const live = livePath(dirs, entry.path);

  if (entry.kind === "absent") {
    // Nothing existed before the deploy. Undo a real deployment, but leave a link or file that
    // appeared afterwards (e.g. from `pnpm install`) alone.
    const liveStats = await lstatOrUndefined(live);
    if (liveStats?.isDirectory()) {
      await rm(live, { recursive: true, force: true });
      console.log(`[deploy-deps] removed deployment: ${entry.path}`);
    } else if (liveStats) {
      console.warn(`[deploy-deps] left in place, installed after the snapshot: ${entry.path}`);
    }
    // Consume the marker: the deployment is undone, so replaying this entry must be a no-op.
    await rm(absentPath(dirs, entry.path), { force: true });
    return;
  }

  const payload = payloadPath(dirs, entry.path);
  const payloadStats = await lstatOrUndefined(payload);
  if (!payloadStats) {
    // The entry came from a directory scan, so this only happens if something removed it after the
    // scan; there is nothing left to put back.
    console.warn(`[deploy-deps] snapshot payload vanished, skipping: ${entry.path}`);
    return;
  }

  const liveStats = await lstatOrUndefined(live);
  if (liveStats?.isSymbolicLink()) {
    // A link installed after the snapshot wins: replacing it could undo a fresh `pnpm install`.
    if (entry.kind === "symlink" && entry.target !== undefined) {
      const target = await readlink(live);
      if (target !== entry.target) {
        console.warn(`[deploy-deps] link target changed, keeping live link: ${entry.path}`);
      } else {
        console.log(`[deploy-deps] already in place: ${entry.path}`);
      }
    } else {
      console.warn(`[deploy-deps] re-linked after the snapshot, keeping live link: ${entry.path}`);
    }

    await rm(payload, { recursive: true, force: true });
    return;
  }

  await rm(live, { recursive: true, force: true });
  await mkdir(dirname(live), { recursive: true });
  await rename(payload, live);
  console.log(`[deploy-deps] restored: ${entry.path} (${entry.kind})`);
}

/**
 * Put every snapshot entry back. Returns how many entries are still on disk afterwards: the
 * snapshot *is* the state, so anything left is an original this run could not restore, and a later
 * run retries it.
 */
export async function restoreDependencies(dirs: SnapshotDirs): Promise<number> {
  if (!(await lstatOrUndefined(dirs.snapshotDir))) {
    console.log("[deploy-deps] nothing to restore");
    return 0;
  }

  for (const entry of await readSnapshotEntries(dirs)) {
    try {
      await restoreEntry(dirs, entry);
    } catch (error) {
      console.error(`[deploy-deps] failed to restore ${entry.path}: ${String(error)}`);
    }
  }

  // Only drop the directory once nothing is left in it: anything still there is an original this
  // run could not put back, and deleting it would destroy the only copy.
  const remaining = await readSnapshotEntries(dirs);
  if (remaining.length > 0) {
    console.warn(
      `[deploy-deps] keeping ${SNAPSHOT_DIR_NAME}: ${remaining.length} unprocessed ${
        remaining.length === 1 ? "entry" : "entries"
      } left on disk`
    );
    return remaining.length;
  }

  await rm(dirs.snapshotDir, { recursive: true, force: true });
  return 0;
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

  const dest = livePath(dirs, pkg.name);
  await mkdir(dest, { recursive: true });

  // `strip: 1` drops the leading `package/` directory from every entry.
  await extract({ file: tarball, cwd: dest, strip: 1 });
}

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
async function warnOnLegacySnapshot(dirs: SnapshotDirs): Promise<void> {
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
      "[deploy-deps] hint: run `node scripts/deploy-deps.ts --restore` to put node_modules back."
    );
    process.exitCode = 1;
  }
}
