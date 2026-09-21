import { execFile as execFileCb } from "node:child_process";
import { resolve } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createProjectTarball } from "../packaging/common/archive.ts";
import {
  CARGO_ZIGBUILD_VERSION,
  RUST_VERSION,
  ZIG_VERSION,
} from "../packaging/common/toolchain.ts";
import { baseManifest, writeManifest } from "../packaging/flatpak/manifest.ts";

const execFile = promisify(execFileCb);

const projectRoot = resolve(import.meta.dirname, "..");

const pkg = JSON.parse(
  await readFile(resolve(projectRoot, "package.json"), "utf-8")
);
const { flatpak: flatpakOptions } = await import(
  new URL("../packaging/options.ts", import.meta.url).href
);

const outDir = resolve(projectRoot, "out/make/flatpak-builder");

await mkdir(outDir, { recursive: true });

// --- Step 2: Fetch pnpm tarball metadata for offline sandbox install ---
const packageManagerField = (pkg.packageManager ?? "") as string;
const pnpmVersionMatch = packageManagerField.match(
  /^pnpm@([^+]+)\+sha512\.([a-f0-9]+)/
);
if (!pnpmVersionMatch) {
  throw new Error(
    `Cannot determine pnpm version/sha512 from packageManager field: ${packageManagerField}`
  );
}
const pnpmVersion = pnpmVersionMatch[1];
const pnpmSha512 = pnpmVersionMatch[2];
const pnpmTarballName = `pnpm-${pnpmVersion}.tgz`;
const pnpmTarballUrl = `https://registry.npmjs.org/pnpm/-/pnpm-${pnpmVersion}.tgz`;
console.log(`Using pnpm ${pnpmVersion} with sha512 from packageManager field.`);

// --- Step 2.5: Extract wasm-bindgen version from Cargo.toml ---
const cargoToml = await readFile(resolve(projectRoot, "Cargo.toml"), "utf-8");
const wasmBindgenVersionMatch = cargoToml.match(
  /^wasm-bindgen\s*=\s*"([^"]+)"/m
);
if (!wasmBindgenVersionMatch) {
  throw new Error("Cannot determine wasm-bindgen version from Cargo.toml");
}
const wasmBindgenVersion = wasmBindgenVersionMatch[1];
console.log(`Using wasm-bindgen ${wasmBindgenVersion}`);

// --- Step 3: Generate pnpm offline sources via flatpak-node-generator ---
const nodeSourcesFile = resolve(outDir, "generated-node-sources.json");
console.log("Running flatpak-node-generator for pnpm...");
await execFile("flatpak-node-generator", [
  "--pnpm-store-version",
  "v11",
  "pnpm",
  resolve(projectRoot, "pnpm-lock.yaml"),
  "-o",
  nodeSourcesFile,
]);
console.log("flatpak-node-generator done.");

// --- Step 4: Generate Cargo vendor sources via flatpak-cargo-generator ---
const cargoSourcesFile = resolve(outDir, "generated-cargo-sources.json");
console.log("Running flatpak-cargo-generator for Cargo...");
await execFile("flatpak-cargo-generator", [
  resolve(projectRoot, "Cargo.lock"),
  "-o",
  cargoSourcesFile,
]);
console.log("flatpak-cargo-generator done.");

// --- Step 4.5: Fetch wasm-bindgen CLI SHA256 checksums from GitHub API ---
const wasmBindgenTargets = [
  { triple: "x86_64-unknown-linux-musl", arch: "x86_64" },
  { triple: "aarch64-unknown-linux-gnu", arch: "aarch64" },
];

interface ReleaseFileSource {
  type: "file";
  url: string;
  sha256: string;
  "dest-filename": string;
  "only-arches": string[];
}

const wasmBindgenSources: ReleaseFileSource[] = [];

console.log("Fetching wasm-bindgen release info from GitHub API...");
const releaseUrl = `https://api.github.com/repos/wasm-bindgen/wasm-bindgen/releases/tags/${wasmBindgenVersion}`;
const releaseResp = await fetch(releaseUrl, {
  headers: { Accept: "application/vnd.github+json" },
});
if (!releaseResp.ok) {
  throw new Error(
    `GitHub API returned ${releaseResp.status} for ${releaseUrl}`
  );
}
const releaseData = (await releaseResp.json()) as {
  assets: Array<{ name: string; browser_download_url: string }>;
};

for (const target of wasmBindgenTargets) {
  const tarballName = `wasm-bindgen-${wasmBindgenVersion}-${target.triple}.tar.gz`;
  const sha256sumName = `${tarballName}.sha256sum`;

  const sha256Asset = releaseData.assets.find((a) => a.name === sha256sumName);
  if (!sha256Asset) {
    throw new Error(`Cannot find ${sha256sumName} in GitHub release assets`);
  }

  console.log(`Fetching SHA256 for ${tarballName}...`);
  const sha256Resp = await fetch(sha256Asset.browser_download_url);
  if (!sha256Resp.ok) {
    throw new Error(
      `Failed to download ${sha256sumName}: ${sha256Resp.status}`
    );
  }
  const sha256Content = await sha256Resp.text();
  // Format: "SHA256  filename" or just "SHA256"
  const sha256 = sha256Content.trim().split(/\s+/)[0];

  wasmBindgenSources.push({
    type: "file",
    url: `https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${wasmBindgenVersion}/${tarballName}`,
    sha256,
    "dest-filename": tarballName,
    "only-arches": [target.arch],
  });
}
console.log("wasm-bindgen CLI sources prepared.");

// --- Step 4.6: Fetch Rust toolchain SHA256 checksums ---
const rustArchTargets = [
  { triple: "x86_64-unknown-linux-gnu", arch: "x86_64" },
  { triple: "aarch64-unknown-linux-gnu", arch: "aarch64" },
];

interface RustSource {
  type: "file";
  url: string;
  sha256: string;
  "dest-filename": string;
  "only-arches"?: string[];
}

const rustSources: RustSource[] = [];

for (const target of rustArchTargets) {
  const tarballName = `rust-${RUST_VERSION}-${target.triple}.tar.xz`;
  const sha256Url = `https://static.rust-lang.org/dist/${tarballName}.sha256`;

  console.log(`Fetching SHA256 for ${tarballName}...`);
  const sha256Resp = await fetch(sha256Url);
  if (!sha256Resp.ok) {
    throw new Error(`Failed to fetch ${sha256Url}: ${sha256Resp.status}`);
  }
  const sha256Content = await sha256Resp.text();
  const sha256 = sha256Content.trim().split(/\s+/)[0];

  rustSources.push({
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
const wasm32Sha256Resp = await fetch(
  `https://static.rust-lang.org/dist/${wasm32StdName}.sha256`
);
if (!wasm32Sha256Resp.ok) {
  throw new Error(
    `Failed to fetch SHA256 for ${wasm32StdName}: ${wasm32Sha256Resp.status}`
  );
}
const wasm32Sha256 = (await wasm32Sha256Resp.text()).trim().split(/\s+/)[0];

rustSources.push({
  type: "file",
  url: `https://static.rust-lang.org/dist/${wasm32StdName}`,
  sha256: wasm32Sha256,
  "dest-filename": wasm32StdName,
});

console.log("Rust toolchain sources prepared.");

// --- Step 4.7: Fetch cargo-zigbuild SHA256 checksums from GitHub API ---
const cargoZigbuildTargets = [
  { triple: "x86_64-unknown-linux-gnu", arch: "x86_64" },
  { triple: "aarch64-unknown-linux-gnu", arch: "aarch64" },
];

const cargoZigbuildSources: ReleaseFileSource[] = [];

console.log("Fetching cargo-zigbuild release info from GitHub API...");
const cargoZigbuildReleaseUrl = `https://api.github.com/repos/rust-cross/cargo-zigbuild/releases/tags/v${CARGO_ZIGBUILD_VERSION}`;
const cargoZigbuildReleaseResp = await fetch(cargoZigbuildReleaseUrl, {
  headers: { Accept: "application/vnd.github+json" },
});
if (!cargoZigbuildReleaseResp.ok) {
  throw new Error(
    `GitHub API returned ${cargoZigbuildReleaseResp.status} for ${cargoZigbuildReleaseUrl}`
  );
}
const cargoZigbuildReleaseData = (await cargoZigbuildReleaseResp.json()) as {
  assets: Array<{ name: string; browser_download_url: string }>;
};

for (const target of cargoZigbuildTargets) {
  const tarballName = `cargo-zigbuild-${target.triple}.tar.xz`;
  const sha256Asset = cargoZigbuildReleaseData.assets.find(
    (a) => a.name === `${tarballName}.sha256`
  );
  if (!sha256Asset) {
    throw new Error(
      `Cannot find ${tarballName}.sha256 in cargo-zigbuild v${CARGO_ZIGBUILD_VERSION} release assets`
    );
  }

  console.log(`Fetching SHA256 for ${tarballName}...`);
  const sha256Resp = await fetch(sha256Asset.browser_download_url);
  if (!sha256Resp.ok) {
    throw new Error(
      `Failed to download ${tarballName}.sha256: ${sha256Resp.status}`
    );
  }
  // Format: "SHA256  filename" or "SHA256 *filename"
  const sha256 = (await sha256Resp.text()).trim().split(/\s+/)[0];

  cargoZigbuildSources.push({
    type: "file",
    url: `https://github.com/rust-cross/cargo-zigbuild/releases/download/v${CARGO_ZIGBUILD_VERSION}/${tarballName}`,
    sha256,
    "dest-filename": tarballName,
    "only-arches": [target.arch],
  });
}
console.log("cargo-zigbuild sources prepared.");

// --- Step 4.8: Fetch Zig SHA256 checksums from the official download index ---
const zigTargets = [
  { triple: "x86_64-linux", arch: "x86_64" },
  { triple: "aarch64-linux", arch: "aarch64" },
];

interface ZigIndexEntry {
  tarball: string;
  shasum: string;
}

const zigSources: ReleaseFileSource[] = [];

console.log("Fetching Zig download index...");
const zigIndexResp = await fetch("https://ziglang.org/download/index.json");
if (!zigIndexResp.ok) {
  throw new Error(`Failed to fetch Zig download index: ${zigIndexResp.status}`);
}
const zigIndex = (await zigIndexResp.json()) as Record<
  string,
  Record<string, ZigIndexEntry | string>
>;
const zigRelease = zigIndex[ZIG_VERSION];
if (!zigRelease) {
  throw new Error(`Zig ${ZIG_VERSION} not found in the download index`);
}

for (const target of zigTargets) {
  const entry = zigRelease[target.triple];
  if (typeof entry !== "object" || entry === null) {
    throw new Error(`No Zig ${ZIG_VERSION} tarball for ${target.triple}`);
  }

  const tarballName = entry.tarball.split("/").pop();
  if (!tarballName) {
    throw new Error(`Cannot derive tarball name from ${entry.tarball}`);
  }

  zigSources.push({
    type: "file",
    url: entry.tarball,
    sha256: entry.shasum,
    "dest-filename": tarballName,
    "only-arches": [target.arch],
  });
}
console.log("Zig sources prepared.");

// --- Step 5: Create project source tarball (or use a remote URL) ---
const { name: pkgName, version: pkgVersion } = pkg as {
  name: string;
  version: string;
};
const sourceTarball = `${pkgName}-${pkgVersion}.tar.gz`;

// Set FLATPAK_SOURCE to a remote archive URL and its sha256 checksum separated
// by '+' (e.g. https://github.com/.../v0.5.0.tar.gz+abc123...) to skip local
// tarball creation and embed the remote URL directly in the manifest.
const flatpakSource = process.env.FLATPAK_SOURCE;
const flatpakSourceMatch = flatpakSource?.match(/^(.+)\+([0-9a-fA-F]{64})$/);

if (flatpakSource && !flatpakSourceMatch) {
  throw new Error('FLATPAK_SOURCE must be in the format "url+sha256hex".');
}

let projectSource: Record<string, unknown>;
if (flatpakSourceMatch) {
  const [, sourceUrl, sourceSha256] = flatpakSourceMatch;
  console.log(`Using remote source: ${sourceUrl}`);
  projectSource = {
    type: "archive",
    url: sourceUrl,
    sha256: sourceSha256,
  };
} else {
  const sourceTarballPath = resolve(outDir, sourceTarball);
  console.log(`Creating project source tarball: ${sourceTarball}`);
  // git-derived file list (tracked + untracked-but-not-ignored), so uncommitted
  // edits are included — same wheel used by the RPM/deb source staging.
  await createProjectTarball(
    projectRoot,
    sourceTarballPath,
    pkgName,
    pkgVersion
  );
  projectSource = {
    type: "archive",
    path: sourceTarball,
  };
}

// --- Step 6: Generate Flatpak builder YAML manifest ---
// Resolved manifest options. These used to come from the
// @malept/electron-installer-flatpak Installer (fed by a fake app dir); since
// the sandbox scaffolding is generated by our own build-scaffold.ts, they are
// computed directly here.
const appId = flatpakOptions.id ?? "";
const appIdentifier = pkg.name;
const runtimeVersion = String(flatpakOptions.runtimeVersion ?? "26.08");
const baseVersion = String(flatpakOptions.baseVersion ?? "26.08");
const finishArgs = flatpakOptions.finishArgs ?? [];

const appModule = {
  name: appIdentifier,
  buildsystem: "simple",
  "build-options": {
    // Make SDK extension binaries and our npm-global-installed pnpm available for all build
    // commands. FLATPAK_BUILDER_BUILDDIR is always /run/build/{module-name} in the sandbox.
    "append-path": `/usr/lib/sdk/node24/bin:/run/build/${appIdentifier}/.npm-prefix/bin:/run/build/${appIdentifier}/.rust/bin`,
    env: {
      XDG_CACHE_HOME: `/run/build/${appIdentifier}/flatpak-node/cache`,
      ELECTRON_OFFLINE_BUILD: "1",
    },
  },
  "build-commands": [
    // Point cargo at the vendored sources generated by flatpak-cargo-generator
    "mkdir -p .cargo",
    "cp cargo/config .cargo/config.toml",

    // Disable supply-chain policies by adding minimumReleaseAge: 0
    // pnpm will use the registry to verify the release age, but we are offline
    "echo 'minimumReleaseAge: 0' >> pnpm-workspace.yaml",

    // Install pnpm into the (writable) build dir using FLATPAK_BUILDER_BUILDDIR
    `npm install -g --prefix $FLATPAK_BUILDER_BUILDDIR/.npm-prefix ./${pnpmTarballName}`,

    // Install dependencies using the offline pnpm store populated by flatpak-node-generator.
    `pnpm install --offline --frozen-lockfile --store-dir $FLATPAK_BUILDER_BUILDDIR/flatpak-node/pnpm-store`,

    // Extract and install wasm-bindgen CLI (build-time only; only the matching arch tarball is downloaded)
    "tar xf wasm-bindgen-*.tar.gz",
    "install -Dm755 wasm-bindgen-*/wasm-bindgen $FLATPAK_BUILDER_BUILDDIR/.npm-prefix/bin/wasm-bindgen",
    "install -Dm755 wasm-bindgen-*/wasm-bindgen-test-runner $FLATPAK_BUILDER_BUILDDIR/.npm-prefix/bin/wasm-bindgen-test-runner || true",

    // Extract and install cargo-zigbuild CLI (build-time only; only the matching arch tarball is downloaded)
    "tar xf cargo-zigbuild-*.tar.xz",
    `install -Dm755 cargo-zigbuild-*/cargo-zigbuild $FLATPAK_BUILDER_BUILDDIR/.npm-prefix/bin/cargo-zigbuild`,

    // Extract Zig (build-time only; only the matching arch tarball is downloaded).
    // cargo-zigbuild shells out to `zig`, which resolves its std lib relative to
    // its own executable, so keep the whole distribution and only symlink the
    // binary onto PATH (selfExePath resolves the symlink back to .zig/zig).
    "tar xf zig-*.tar.xz",
    `mv zig-*-linux-*/ $FLATPAK_BUILDER_BUILDDIR/.zig`,
    `ln -sf $FLATPAK_BUILDER_BUILDDIR/.zig/zig $FLATPAK_BUILDER_BUILDDIR/.npm-prefix/bin/zig`,

    // Install Rust toolchain (build-time only; only the matching arch tarball is downloaded)
    `tar xf rust-${RUST_VERSION}-*.tar.xz`,
    `./rust-${RUST_VERSION}-*/install.sh --prefix=$FLATPAK_BUILDER_BUILDDIR/.rust --without=rust-docs --disable-ldconfig`,
    // Install wasm32-unknown-unknown std library
    `tar xf rust-std-${RUST_VERSION}-wasm32-unknown-unknown.tar.xz`,
    `cp -r rust-std-${RUST_VERSION}-wasm32-unknown-unknown/rust-std-wasm32-unknown-unknown/lib/rustlib/wasm32-unknown-unknown $FLATPAK_BUILDER_BUILDDIR/.rust/lib/rustlib/wasm32-unknown-unknown`,

    `pnpm run build:modules`,

    // Package the Electron app
    `pnpm run package`,

    // Generate the desktop entry, icons, and /app/bin symlink with our
    // scaffold, using the actual packaged Electron app as source.
    `node scripts/build-scaffold.ts /app --name ${appIdentifier} --desktop-name ${appId} --icon-app-name ${appId} --app-path /lib/${appIdentifier} --icons-path /share/icons/hicolor --desktop-path /share/applications --symlink-path /bin/${appIdentifier} --with-zypak-wrapper`,

    // Install the built Electron app into /app/lib/{name}
    `install -d /app/lib/${appIdentifier}`,
    `cp -r out/${pkg.name}-linux-*/. /app/lib/${appIdentifier}/`,

    // Install AppStream metainfo
    `install -Dm644 packaging/flatpak/metainfo.xml /app/share/metainfo/${appId}.metainfo.xml`,
  ],
  sources: [
    "generated-node-sources.json",
    {
      type: "file",
      url: pnpmTarballUrl,
      sha512: pnpmSha512,
      "dest-filename": pnpmTarballName,
    },
    "generated-cargo-sources.json",
    ...wasmBindgenSources,
    ...rustSources,
    ...cargoZigbuildSources,
    ...zigSources,
    projectSource,
  ],
};

// Top-level manifest is shared with build/vite-plugins/MakerFlatpak.ts (prebuilt mode).
const manifest = baseManifest(
  {
    appId,
    appIdentifier,
    runtimeVersion,
    baseVersion,
    finishArgs,
    extraModules: flatpakOptions.modules,
  },
  appModule
);

const manifestPath = await writeManifest(outDir, manifest);

console.log("Flatpak builder manifest written to:");
console.log(`  ${manifestPath}`);
