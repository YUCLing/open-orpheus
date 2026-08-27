import { execFile as execFileCb, spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { createProjectTarball } from "../common/archive.ts";
import { createRulesFile } from "./rules.ts";

const execFile = promisify(execFileCb);

function runStreaming(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...opts });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

export interface DebOptions {
  projectRoot?: string;
  outDir?: string;
  /** Bake the toolchain install (rust/node/pnpm) into the rendered `debian/rules`. Defaults to true. */
  installTools?: boolean;
  /** Pass `-d` to dpkg-buildpackage to skip the build-dependency check. Defaults to false. */
  nodeps?: boolean;
}

async function resolveMeta(projectRoot: string) {
  const pkg = JSON.parse(
    await readFile(resolve(projectRoot, "package.json"), "utf-8")
  );
  const { deb: debOptions } = await import(
    resolve(projectRoot, "packaging/options.ts")
  );
  return { pkg, debOptions };
}

/**
 * Create `name_version.orig.tar.gz` and stage a source tree with `debian/`
 * into `outDir`. Returns the staged source directory.
 */
async function stageSource(
  projectRoot: string,
  outDir: string,
  name: string,
  version: string,
  installTools?: boolean
) {
  await mkdir(outDir, { recursive: true });

  const origTarball = resolve(outDir, `${name}_${version}.orig.tar.gz`);
  await createProjectTarball(projectRoot, origTarball, name, version, [
    "packaging/resources/debian",
  ]);

  await execFile("tar", ["xzf", origTarball, "-C", outDir]);

  const srcDir = resolve(outDir, `${name}-${version}`);
  // The Debian packaging lives in packaging/resources/debian; it is copied
  // into the staged tree as `debian/` (where dpkg-buildpackage expects it)
  // and is excluded from the orig tarball. `debian/rules` is rendered from
  // rules.ejs so the toolchain decision is baked in at source-package
  // creation time — mirroring how the SRPM bakes `installTools` into the spec.
  await cp(
    resolve(projectRoot, "packaging/resources/debian"),
    resolve(srcDir, "debian"),
    { recursive: true }
  );
  await rm(resolve(srcDir, "debian", "rules.ejs"));
  await createRulesFile(resolve(srcDir, "debian", "rules"), { installTools });
  return srcDir;
}

/** Build the binary `.deb` directly. Returns the produced `.deb` paths. */
export async function buildDeb(options: DebOptions = {}): Promise<string[]> {
  const projectRoot =
    options.projectRoot ?? resolve(import.meta.dirname, "../..");
  const outDir = options.outDir ?? resolve(projectRoot, "out/make/deb");
  const { pkg, debOptions } = await resolveMeta(projectRoot);

  const name = debOptions.name;
  const version: string = pkg.version;
  const srcDir = await stageSource(
    projectRoot,
    outDir,
    name,
    version,
    options.installTools
  );

  // -d (only with `--nodeps`): skip dpkg-checkbuilddeps' implicit
  // build-essential:native check — debian/rules provisions its own toolchain.
  const buildArgs = ["-b", "-us", "-uc"];
  if (options.nodeps) buildArgs.unshift("-d");
  await runStreaming("dpkg-buildpackage", buildArgs, {
    cwd: srcDir,
  });

  const debs = (await readdir(outDir))
    .filter((f) => f.endsWith(".deb"))
    .map((f) => resolve(outDir, f));

  await rm(srcDir, { recursive: true, force: true });

  if (debs.length === 0) {
    throw new Error("dpkg-buildpackage produced no .deb files.");
  }
  return debs;
}

/**
 * Build the Debian source package (`.dsc` + `.orig.tar.gz` + `.debian.tar.xz`)
 * for upload to a PPA. Returns the produced file paths.
 */
export async function buildDebSource(
  options: DebOptions = {}
): Promise<string[]> {
  const projectRoot =
    options.projectRoot ?? resolve(import.meta.dirname, "../..");
  const outDir = options.outDir ?? resolve(projectRoot, "out/make/deb-src");
  const { pkg, debOptions } = await resolveMeta(projectRoot);

  const name = debOptions.name;
  const version: string = pkg.version;
  const srcDir = await stageSource(
    projectRoot,
    outDir,
    name,
    version,
    options.installTools
  );

  // -d (only with `--nodeps`): skip dpkg-checkbuilddeps' implicit
  // build-essential:native check (we only produce the source package here;
  // the PPA builder installs Build-Depends).
  // -S: source only, -sa: include the orig tarball, -us -uc: no signing.
  const buildArgs = ["-S", "-sa", "-us", "-uc"];
  if (options.nodeps) buildArgs.unshift("-d");
  await runStreaming("dpkg-buildpackage", buildArgs, {
    cwd: srcDir,
  });

  const files = (await readdir(outDir)).filter((f) =>
    /\.(dsc|orig\.tar\.gz|debian\.tar\.(gz|xz))$/.test(f)
  );

  await rm(srcDir, { recursive: true, force: true });

  return files.map((f) => resolve(outDir, f));
}
