import { execFile as execFileCb } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { createProjectTarball } from "../common/archive.ts";
import { createPrebuiltBundle } from "../common/prebuilt.ts";
import { runStreaming } from "../common/process.ts";
import {
  createControlFile,
  resolveControlOptions,
  type ControlOptions,
} from "./control.ts";
import { createRulesFile } from "./rules.ts";

const execFile = promisify(execFileCb);

export interface DebOptions {
  projectRoot?: string;
  outDir?: string;
  /** Bake the toolchain install (rust/node/pnpm) into the rendered `debian/rules`. Defaults to true. */
  installTools?: boolean;
  /** Pass `-d` to dpkg-buildpackage to skip the build-dependency check. Defaults to false. */
  nodeps?: boolean;
  /** Path to a prebuilt packaged app dir (out/<name>-linux-<arch>) to bundle instead of compiling. */
  prebuilt?: string;
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
 * Parse the upstream version of the top `debian/changelog` entry, e.g.
 * `open-orpheus (0.16.2-1) unstable; urgency=medium` → `0.16.2` (revision
 * stripped). Returns undefined if no entry can be parsed.
 */
function parseChangelogVersion(changelog: string): string | undefined {
  const match = changelog.match(/^\S+ \(([^)]+)\) /m);
  if (!match) return undefined;
  return match[1].replace(/-\d+$/, "");
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
  options: {
    installTools?: boolean;
    prebuilt?: string;
    control: ControlOptions;
  }
) {
  await mkdir(outDir, { recursive: true });

  const origTarball = resolve(outDir, `${name}_${version}.orig.tar.gz`);

  // 1. Extract the git-derived project source (debian/ excluded) into the
  //    staged tree.
  const baseOrig = resolve(outDir, `${name}_${version}.orig.base.tar.gz`);
  await createProjectTarball(projectRoot, baseOrig, name, version, [
    "packaging/resources/debian",
  ]);
  await execFile("tar", ["xzf", baseOrig, "-C", outDir]);

  const srcDir = resolve(outDir, `${name}-${version}`);

  // 2. Bundle the prebuilt app + scaffold into the staged tree so the build
  //    can install it without compiling.
  if (options.prebuilt) {
    await createPrebuiltBundle(
      projectRoot,
      options.prebuilt,
      name,
      resolve(srcDir, "prebuilt")
    );
  }

  // 3. Recreate the orig tarball from the staged tree so the prebuilt bundle
  //    is part of the source package (needed for PPA rebuilds).
  await rm(baseOrig, { force: true });
  await execFile("tar", [
    "czf",
    origTarball,
    "-C",
    outDir,
    `${name}-${version}`,
  ]);

  // 4. The Debian packaging lives in packaging/resources/debian; it is copied
  //    into the staged tree as `debian/` (where dpkg-buildpackage expects it)
  //    and is excluded from the orig tarball. `debian/rules` is rendered from
  //    rules.ejs so the toolchain/prebuilt decisions are baked in at
  //    source-package creation time — mirroring the SRPM spec.
  await cp(
    resolve(projectRoot, "packaging/resources/debian"),
    resolve(srcDir, "debian"),
    { recursive: true }
  );
  await rm(resolve(srcDir, "debian", "rules.ejs"));
  await createRulesFile(resolve(srcDir, "debian", "rules"), {
    name,
    installTools: options.installTools,
    prebuilt: !!options.prebuilt,
  });
  await rm(resolve(srcDir, "debian", "control.ejs"));
  await createControlFile(
    resolve(srcDir, "debian", "control"),
    options.control
  );

  // 5. dpkg-source derives the source version from the changelog and uses it
  //    to locate `name_<version>.orig.tar.gz`, so the top entry MUST match the
  //    package version. Fail early instead of producing an unbuildable source
  //    package (the release workflow keeps these in sync via generate-changelog.ts).
  const changelog = await readFile(
    resolve(srcDir, "debian", "changelog"),
    "utf-8"
  );
  const changelogVersion = parseChangelogVersion(changelog);
  if (changelogVersion !== version) {
    throw new Error(
      `debian/changelog top version (${changelogVersion ?? "missing"}) does not ` +
        `match package version (${version}). Run the release workflow or update ` +
        `packaging/resources/debian/changelog before building a source package.`
    );
  }
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
  const srcDir = await stageSource(projectRoot, outDir, name, version, {
    installTools: options.installTools,
    prebuilt: options.prebuilt,
    control: resolveControlOptions(debOptions, pkg),
  });

  // -d (only with `--nodeps`): skip dpkg-checkbuilddeps' implicit
  // build-essential:native check — debian/rules provisions its own toolchain.
  const buildArgs = ["-b", "-us", "-uc"];
  if (options.nodeps) buildArgs.unshift("-d");
  await runStreaming("dpkg-buildpackage", buildArgs, {
    cwd: srcDir,
  });

  // Collect the produced .deb and remove every other artifact (staged source
  // tree, .orig.tar.gz, .buildinfo, .changes) so only the .deb remains.
  const debs: string[] = [];
  for (const f of await readdir(outDir)) {
    if (f.endsWith(".deb")) {
      debs.push(resolve(outDir, f));
    } else {
      await rm(resolve(outDir, f), { recursive: true, force: true });
    }
  }

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
  const srcDir = await stageSource(projectRoot, outDir, name, version, {
    installTools: options.installTools,
    prebuilt: options.prebuilt,
    control: resolveControlOptions(debOptions, pkg),
  });

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
