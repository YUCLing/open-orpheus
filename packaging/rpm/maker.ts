import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { MakerBase, MakerOptions } from "@electron-forge/maker-base";
import type { ForgeArch, ForgePlatform } from "@electron-forge/shared-types";

import { scaffold, type HicolorIcons } from "../common/scaffolder";

const execFileAsync = promisify(execFile);

// #region Architecture mapping

function rpmArch(nodeArch: ForgeArch): string {
  switch (nodeArch) {
    case "ia32":
      return "i386";
    case "x64":
      return "x86_64";
    case "arm64":
      return "aarch64";
    case "armv7l":
      return "armv7hl";
    case "arm":
      return "armv6hl";
    default:
      return nodeArch;
  }
}
// #endregion

// #region Config

export interface CustomMakerRpmConfig {
  /** Options forwarded to the scaffolder (and into the RPM spec). */
  options?: {
    /** Hicolor icon map (size key → source path). */
    icons?: HicolorIcons;
    /** Path to a `.desktop` file. Defaults to the project's own. */
    desktopFile?: string;
    /** The binary to expose on `$PATH`. Defaults to the app name. */
    bin?: string;
  };
}
// #endregion

// #region Maker

export default class CustomMakerRpm extends MakerBase<CustomMakerRpmConfig> {
  name = "rpm";

  defaultPlatforms: ForgePlatform[] = ["linux"];

  requiredExternalBinaries: string[] = ["rpmbuild"];

  isSupportedOnCurrentPlatform(): boolean {
    return process.platform === "linux";
  }

  async make(opts: MakerOptions): Promise<string[]> {
    const arch = rpmArch(opts.targetArch);
    const outDir = resolve(opts.makeDir, "rpm", opts.targetArch);
    await this.ensureDirectory(outDir);

    // --- Resolve metadata ------------------------------------------------
    const pkg = opts.packageJSON as {
      productName?: string;
      name?: string;
      version?: string;
      description?: string;
      license?: string;
      homepage?: string;
    };
    const appName = pkg.productName ?? pkg.name ?? "app";
    const version = pkg.version ?? "0.0.0";
    const description = pkg.description ?? appName;
    const license = pkg.license ?? "MIT";
    const homepage = pkg.homepage ?? "";

    // --- Staging directory -----------------------------------------------
    const stagingDir = join(tmpdir(), `rpm-${appName}-${Date.now()}`);
    await mkdir(stagingDir, { recursive: true });
    const buildDir = join(stagingDir, "BUILD");

    // --- 1. Scaffold /usr tree into BUILD/ -------------------------------
    await scaffold({
      src: opts.dir,
      dest: buildDir,
      icons: this.config.options?.icons,
      desktopFile: this.config.options?.desktopFile,
      bin: this.config.options?.bin,
    });

    // --- 2. Walk BUILD/usr/ to generate the %files list ------------------
    const filesList = await walkFiles(buildDir);

    // --- 3. Write the spec file ------------------------------------------
    const specDir = join(stagingDir, "SPECS");
    await mkdir(specDir, { recursive: true });
    const specPath = join(specDir, `${appName}.spec`);

    const spec = generateSpec({
      name: appName,
      version,
      description,
      license,
      homepage,
      arch,
      files: filesList,
    });
    await writeFile(specPath, spec, "utf-8");

    // --- 4. Run rpmbuild -------------------------------------------------
    // rpmbuild needs the RPMS directory to exist
    await mkdir(join(stagingDir, "RPMS", arch), { recursive: true });

    try {
      const { stdout, stderr } = await execFileAsync("rpmbuild", [
        "-bb",
        specPath,
        "--target",
        `${arch}-none-linux`,
        "--define",
        `_topdir ${stagingDir}`,
      ]);
      if (stdout) console.log(stdout);
      if (stderr) console.error(stderr);
    } catch (err) {
      const childErr = err as {
        stdout?: string;
        stderr?: string;
        message?: string;
        code?: number;
      };
      console.error("=== rpmbuild FAILED (exit %d) ===", childErr.code);
      console.error("=== SPEC FILE (%s) ===", specPath);
      console.error(spec);
      if (childErr.stdout)
        console.error("=== rpmbuild stdout ===\n%s", childErr.stdout);
      if (childErr.stderr)
        console.error("=== rpmbuild stderr ===\n%s", childErr.stderr);
      throw new Error(`rpmbuild failed: ${childErr.message ?? String(err)}`, {
        cause: err,
      });
    }

    // --- 5. Move resulting .rpm to outDir --------------------------------
    const rpmsDir = join(stagingDir, "RPMS", arch);
    const results: string[] = [];
    try {
      const entries = await readdir(rpmsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".rpm")) {
          const src = join(rpmsDir, entry.name);
          const dest = join(outDir, entry.name);
          await copyFile(src, dest);
          results.push(dest);
        }
      }
    } catch {
      throw new Error(
        `No .rpm found in ${rpmsDir}. rpmbuild may have failed silently.`
      );
    }

    return results;
  }
}
// #endregion

// #region Spec generator

interface SpecInput {
  name: string;
  version: string;
  description: string;
  license: string;
  homepage: string;
  arch: string;
  files: string[];
}

function generateSpec(input: SpecInput): string {
  const fileLines = input.files.join("\n");

  // TODO: Handle dependencies

  return `\
Name:           ${input.name}
Version:        ${input.version}
Release:        1
Summary:        ${input.description}

License:        ${input.license}${input.homepage ? `\nURL:            ${input.homepage}` : ""}

BuildArch:      ${input.arch}

%description
${input.description}

%install
mkdir -p %{buildroot}
cp -a %{_topdir}/BUILD/usr %{buildroot}/

%files
${fileLines}
`;
}
// #endregion

// #region File walker

async function walkFiles(root: string): Promise<string[]> {
  const result: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = `/${relative(root, full)}`; // e.g. "/usr/bin/open-orpheus"

      if (entry.isDirectory()) {
        // Recurse into subdirectories but don't add the directory
        // itself to %files — RPM auto-creates parent directories
        // and would flag them as duplicates.
        await walk(full);
      } else if (entry.isSymbolicLink()) {
        result.push(rel);
      } else if (entry.isFile()) {
        result.push(rel);
      }
    }
  }

  await walk(root);
  return result;
}
// #endregion
