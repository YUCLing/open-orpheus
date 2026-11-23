import { execFile as execFileCb } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { createProjectTarball } from "../common/archive.ts";
import { RUST_VERSION } from "../../config/toolchain.ts";
import { PNPM_NATIVE_PACKAGES } from "./manifest.ts";

const execFile = promisify(execFileCb);

export interface SubmoduleSource {
  type: "git";
  url: string;
  commit: string;
  dest: string;
}

export interface ReleaseFileSource {
  type: "file";
  url: string;
  sha256: string;
  "dest-filename": string;
  "only-arches": string[];
}

export interface RustSource {
  type: "file";
  url: string;
  sha256: string;
  "dest-filename": string;
  "only-arches"?: string[];
}

export interface PnpmSources {
  version: string;
  sha512: string;
  tarballName: string;
  tarballUrl: string;
  /** npm `dist.integrity` per `@pnpm/exe.*` package name. */
  nativeIntegrities: Record<string, string>;
}

/**
 * The parent tag archive never contains submodule contents. Emit one pinned
 * git source per submodule, at the commit recorded by the parent index.
 */
export async function createPinnedSubmoduleSources(
  projectRoot: string
): Promise<SubmoduleSource[]> {
  const { stdout: config } = await execFile("git", [
    "-C",
    projectRoot,
    "config",
    "-f",
    ".gitmodules",
    "--get-regexp",
    "^submodule\\..*\\.path$",
  ]);

  const entries = config
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(" ");
      const key = line.slice(0, space);
      return {
        name: key.slice("submodule.".length, -".path".length),
        path: line.slice(space + 1).trim(),
      };
    });

  const sources: SubmoduleSource[] = [];
  for (const entry of entries) {
    const { stdout: tree } = await execFile("git", [
      "-C",
      projectRoot,
      "ls-tree",
      "HEAD",
      "--",
      entry.path,
    ]);
    const commit = tree.trim().split(/\s+/)[2];
    if (!commit) {
      throw new Error(`Cannot resolve the gitlink for submodule ${entry.path}`);
    }

    const { stdout: configUrl } = await execFile("git", [
      "-C",
      projectRoot,
      "config",
      "-f",
      ".gitmodules",
      "--get",
      `submodule.${entry.name}.url`,
    ]);
    let url = configUrl.trim();
    if (url.startsWith("./") || url.startsWith("../")) {
      const { stdout: remoteUrl } = await execFile("git", [
        "-C",
        resolve(projectRoot, entry.path),
        "config",
        "--get",
        "remote.origin.url",
      ]);
      url = remoteUrl.trim();
    }
    if (!url) {
      throw new Error(`Cannot resolve the URL for submodule ${entry.path}`);
    }

    sources.push({ type: "git", url, commit, dest: entry.path });
  }

  return sources;
}

/**
 * Resolve the pnpm wrapper tarball plus the registry integrities of the native
 * binaries it links (`@pnpm/exe.*`) for the offline Flatpak install.
 */
export async function resolvePnpmSources(pkg: { packageManager?: string }): Promise<PnpmSources> {
  const packageManagerField = (pkg.packageManager ?? "") as string;
  const pnpmVersionMatch = packageManagerField.match(/^pnpm@([^+]+)\+sha512\.([a-f0-9]+)/);
  if (!pnpmVersionMatch) {
    throw new Error(
      `Cannot determine pnpm version/sha512 from packageManager field: ${packageManagerField}`
    );
  }
  const version = pnpmVersionMatch[1];
  const sha512 = pnpmVersionMatch[2];
  const tarballName = `pnpm-${version}.tgz`;
  const tarballUrl = `https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz`;
  console.log(`Using pnpm ${version} with sha512 from packageManager field.`);

  // The npm `pnpm` package is only a wrapper: its preinstall script links a
  // native binary out of a platform-specific optional dependency, which the
  // offline sandbox cannot let npm resolve. That package is declared as a
  // source instead (see pnpmNativeSources / pnpmBootstrapCommands), so its
  // integrity has to be pinned here.
  const nativeIntegrities: Record<string, string> = {};

  for (const [arch, packageName] of Object.entries(PNPM_NATIVE_PACKAGES)) {
    const metadataUrl = `https://registry.npmjs.org/${packageName}/${version}`;
    console.log(`Fetching registry integrity for ${packageName} (${arch})...`);
    const resp = await fetch(metadataUrl);
    if (!resp.ok) {
      throw new Error(`Registry returned ${resp.status} for ${metadataUrl}`);
    }
    const metadata = (await resp.json()) as { dist?: { integrity?: string } };
    const integrity = metadata.dist?.integrity;
    if (integrity === undefined) {
      throw new Error(`No dist.integrity in the registry metadata for ${packageName}`);
    }
    nativeIntegrities[packageName] = integrity;
  }
  console.log("pnpm native binary sources prepared.");

  return { version, sha512, tarballName, tarballUrl, nativeIntegrities };
}

/** Read the `wasm-bindgen` version pinned in the root `Cargo.toml`. */
export async function readWasmBindgenVersion(projectRoot: string): Promise<string> {
  const cargoToml = await readFile(resolve(projectRoot, "Cargo.toml"), "utf-8");
  const match = cargoToml.match(/^wasm-bindgen\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error("Cannot determine wasm-bindgen version from Cargo.toml");
  }
  console.log(`Using wasm-bindgen ${match[1]}`);
  return match[1];
}

/** Fetch the wasm-bindgen CLI release tarballs and their SHA-256 checksums. */
export async function resolveWasmBindgenSources(
  projectRoot: string
): Promise<{ version: string; sources: ReleaseFileSource[] }> {
  const version = await readWasmBindgenVersion(projectRoot);
  const targets = [
    { triple: "x86_64-unknown-linux-musl", arch: "x86_64" },
    { triple: "aarch64-unknown-linux-gnu", arch: "aarch64" },
  ];

  const sources: ReleaseFileSource[] = [];

  console.log("Fetching wasm-bindgen release info from GitHub API...");
  const releaseUrl = `https://api.github.com/repos/wasm-bindgen/wasm-bindgen/releases/tags/${version}`;
  const releaseResp = await fetch(releaseUrl, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!releaseResp.ok) {
    throw new Error(`GitHub API returned ${releaseResp.status} for ${releaseUrl}`);
  }
  const releaseData = (await releaseResp.json()) as {
    assets: Array<{ name: string; browser_download_url: string }>;
  };

  for (const target of targets) {
    const tarballName = `wasm-bindgen-${version}-${target.triple}.tar.gz`;
    const sha256sumName = `${tarballName}.sha256sum`;

    const sha256Asset = releaseData.assets.find((a) => a.name === sha256sumName);
    if (!sha256Asset) {
      throw new Error(`Cannot find ${sha256sumName} in GitHub release assets`);
    }

    console.log(`Fetching SHA256 for ${tarballName}...`);
    const sha256Resp = await fetch(sha256Asset.browser_download_url);
    if (!sha256Resp.ok) {
      throw new Error(`Failed to download ${sha256sumName}: ${sha256Resp.status}`);
    }
    const sha256Content = await sha256Resp.text();
    // Format: "SHA256  filename" or just "SHA256"
    const sha256 = sha256Content.trim().split(/\s+/)[0];

    sources.push({
      type: "file",
      url: `https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${version}/${tarballName}`,
      sha256,
      "dest-filename": tarballName,
      "only-arches": [target.arch],
    });
  }
  console.log("wasm-bindgen CLI sources prepared.");

  return { version, sources };
}

/** Fetch the pinned Rust toolchain and wasm32 std library with SHA-256 checksums. */
export async function resolveRustSources(): Promise<RustSource[]> {
  const targets = [
    { triple: "x86_64-unknown-linux-gnu", arch: "x86_64" },
    { triple: "aarch64-unknown-linux-gnu", arch: "aarch64" },
  ];

  const sources: RustSource[] = [];

  for (const target of targets) {
    const tarballName = `rust-${RUST_VERSION}-${target.triple}.tar.xz`;
    const sha256Url = `https://static.rust-lang.org/dist/${tarballName}.sha256`;

    console.log(`Fetching SHA256 for ${tarballName}...`);
    const sha256Resp = await fetch(sha256Url);
    if (!sha256Resp.ok) {
      throw new Error(`Failed to fetch ${sha256Url}: ${sha256Resp.status}`);
    }
    const sha256Content = await sha256Resp.text();
    const sha256 = sha256Content.trim().split(/\s+/)[0];

    sources.push({
      type: "file",
      url: `https://static.rust-lang.org/dist/${tarballName}`,
      sha256,
      "dest-filename": tarballName,
      "only-arches": [target.arch],
    });
  }

  // wasm32-unknown-unknown std (arch-independent)
  const wasm32StdName = `rust-std-${RUST_VERSION}-wasm32-unknown-unknown.tar.xz`;
  console.log(`Fetching SHA256 for ${wasm32StdName}...`);
  const wasm32Sha256Resp = await fetch(`https://static.rust-lang.org/dist/${wasm32StdName}.sha256`);
  if (!wasm32Sha256Resp.ok) {
    throw new Error(`Failed to fetch SHA256 for ${wasm32StdName}: ${wasm32Sha256Resp.status}`);
  }
  const wasm32Sha256 = (await wasm32Sha256Resp.text()).trim().split(/\s+/)[0];

  sources.push({
    type: "file",
    url: `https://static.rust-lang.org/dist/${wasm32StdName}`,
    sha256: wasm32Sha256,
    "dest-filename": wasm32StdName,
  });

  console.log("Rust toolchain sources prepared.");

  return sources;
}

export interface ProjectSource {
  source: Record<string, unknown>;
  submodules: SubmoduleSource[];
}

/**
 * Resolve the project source entry for the manifest.
 *
 * Set `FLATPAK_SOURCE` to a remote archive URL and its sha256 checksum
 * separated by `+` to skip local tarball creation and embed the remote URL
 * directly; otherwise create a git-derived tarball in `outDir`.
 */
export async function resolveProjectSource(
  projectRoot: string,
  pkg: { name: string; version: string },
  outDir: string
): Promise<ProjectSource> {
  const sourceTarball = `${pkg.name}-${pkg.version}.tar.gz`;

  const flatpakSource = process.env.FLATPAK_SOURCE;
  const flatpakSourceMatch = flatpakSource?.match(/^(.+)\+([0-9a-fA-F]{64})$/);

  if (flatpakSource && !flatpakSourceMatch) {
    throw new Error('FLATPAK_SOURCE must be in the format "url+sha256hex".');
  }

  if (flatpakSourceMatch) {
    const [, sourceUrl, sourceSha256] = flatpakSourceMatch;
    console.log(`Using remote source: ${sourceUrl}`);
    return {
      source: { type: "archive", url: sourceUrl, sha256: sourceSha256 },
      submodules: await createPinnedSubmoduleSources(projectRoot),
    };
  }

  const sourceTarballPath = resolve(outDir, sourceTarball);
  console.log(`Creating project source tarball: ${sourceTarball}`);
  // git-derived file list (tracked + untracked-but-not-ignored), so uncommitted
  // edits are included — same wheel used by the RPM/deb source staging.
  await createProjectTarball(projectRoot, sourceTarballPath, pkg.name, pkg.version);
  return {
    source: { type: "archive", path: sourceTarball },
    submodules: [],
  };
}
