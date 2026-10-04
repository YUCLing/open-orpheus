import { spawn, type SpawnOptions } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { extract, list } from "tar";

const root = resolve(import.meta.dirname, "..");

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
 * Extract a packed module tarball (as produced by `pnpm pack`) directly into
 * `node_modules`, replacing the workspace symlink with the deployed files.
 */
async function deployTarball(tarball: string): Promise<void> {
  const pkg = await readPackedManifest(tarball);
  const dest = resolve(root, "node_modules", pkg.name);

  // Clear whatever currently sits at this path so the deployed files replace it: a pnpm
  // workspace symlink is unlinked, a real directory is removed recursively. `rm` never
  // follows the link, so the module sources outside `node_modules` are left untouched.
  await rm(dest, { recursive: true, force: true });

  // Modules that don't apply to the current platform (e.g. win32-only on Linux) are not
  // extracted, but their existing link/folder is still dropped so it isn't packaged.
  if (!isPlatformCompatible(pkg.os)) return;

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

const restore = process.argv.includes("--restore");

if (!restore) {
  const packDir = await mkdtemp(join(tmpdir(), "pack-"));

  try {
    await asyncSpawn("pnpm", ["pack", "-r", "-F", '"./modules/*"', "--pack-destination", packDir]);

    const packs = (await readdir(packDir)).filter((name) => name.endsWith(".tgz"));
    for (const pack of packs) {
      await deployTarball(resolve(packDir, pack));
    }
  } finally {
    await rm(packDir, { recursive: true, force: true });
  }
}
