import { access, cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

/**
 * The packaged Electron app directory produced by `pnpm package`:
 * `out/<name>-linux-<arch>/`. Uses the host arch unless `arch` is given.
 * Throws if the directory doesn't exist.
 */
export async function resolvePrebuiltAppDir(
  projectRoot: string,
  name: string,
  arch?: string
): Promise<string> {
  const archs = arch ? [arch] : [process.arch];
  for (const a of archs) {
    const dir = resolve(projectRoot, "out", `${name}-linux-${a}`);
    try {
      await access(dir);
      return dir;
    } catch {
      // try the next candidate arch
    }
  }
  throw new Error(
    `No packaged Electron app found (out/${name}-linux-<arch>). Run \`pnpm package\` first.`
  );
}

/**
 * Assemble a prebuilt bundle at `dest` containing:
 *  - `app/`      — the packaged Electron app (copied from `appDir`)
 *  - `scaffold/` — the generated install scaffolding (`usr/` layout)
 *
 * The scaffold is generated locally with `scripts/build-scaffold.ts` (it only
 * needs `node_modules`, which are present after `pnpm package`). Returns `dest`.
 */
export async function createPrebuiltBundle(
  projectRoot: string,
  appDir: string,
  name: string,
  dest: string
): Promise<string> {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });

  await cp(appDir, resolve(dest, "app"), { recursive: true });

  const scaffoldOut = resolve(dest, "scaffold");
  await mkdir(scaffoldOut, { recursive: true });
  await execFile(
    process.execPath,
    [resolve(projectRoot, "scripts/build-scaffold.ts"), scaffoldOut],
    { cwd: projectRoot }
  );

  return dest;
}
