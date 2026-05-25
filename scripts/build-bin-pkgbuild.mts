import { resolve, dirname } from "node:path";
import { readFile, writeFile, mkdir, cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import got from "got";

const execFile = promisify(execFileCb);

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const GITHUB_REPO = "YUCLing/open-orpheus";
const PKGBUILD_TEMPLATE = resolve(projectRoot, "packaging/aur/bin/PKGBUILD");
const OUT_DIR = resolve(projectRoot, "out/make/aur/bin");

// ── Parse release name ────────────────────────────────────────────────
const releaseName = process.argv[2] || "latest";

// ── Fetch release from GitHub ─────────────────────────────────────────
const releaseUrl =
  releaseName === "latest"
    ? `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
    : `https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${
        releaseName.startsWith("v") ? releaseName : `v${releaseName}`
      }`;

console.log(`Fetching release: ${releaseUrl}`);
const release = await got(releaseUrl).json<{
  tag_name: string;
  tarball_url: string;
  assets: Array<{
    name: string;
    digest: string;
  }>;
}>();

const tagName = release.tag_name; // e.g. "v0.12.2"
const pkgver = tagName.replace(/^v/, ""); // e.g. "0.12.2"
const pkgname = "open-orpheus"; // matches PKGBUILD
console.log(`Release tag: ${tagName}, pkgver: ${pkgver}`);

// ── Locate .deb assets and extract SHA256 digests ─────────────────────
const amd64Asset = release.assets.find(
  (a) => a.name === `${pkgname}_${pkgver}_amd64.deb`
);
const arm64Asset = release.assets.find(
  (a) => a.name === `${pkgname}_${pkgver}_arm64.deb`
);

if (!amd64Asset || !arm64Asset) {
  console.error(
    "Available assets:",
    release.assets.map((a) => a.name)
  );
  throw new Error(`Could not find required .deb assets in release ${tagName}`);
}

// GitHub provides digest in "sha256:<hex>" format
const sha256_amd64 = amd64Asset.digest.replace(/^sha256:/, "");
const sha256_arm64 = arm64Asset.digest.replace(/^sha256:/, "");
console.log(`SHA256 amd64:  ${sha256_amd64}`);
console.log(`SHA256 arm64:  ${sha256_arm64}`);

// ── Download source tarball to extract package.json & LICENSE ─────────
const extractDir = resolve(tmpdir(), `pkgbuild-src-${tagName}`);
const tmpTarball = resolve(tmpdir(), `pkgbuild-src-${tagName}.tar.gz`);
try {
  console.log(`Downloading source tarball: ${release.tarball_url}`);
  await pipeline(
    got.stream(release.tarball_url),
    createWriteStream(tmpTarball)
  );

  await mkdir(extractDir, { recursive: true });
  await execFile("tar", [
    "-xzf",
    tmpTarball,
    "-C",
    extractDir,
    "--strip-components=1",
  ]);
  console.log(`Extracted source to ${extractDir}`);

  // Read electron version from the release's package.json
  const releasePkg = JSON.parse(
    await readFile(resolve(extractDir, "package.json"), "utf-8")
  );
  const electronDep: string = releasePkg.devDependencies.electron;
  const electronMajor = electronDep.split(".")[0];
  console.log(`_electronversion from release: ${electronMajor}`);

  // ── Read and update PKGBUILD template ───────────────────────────────
  let pkgbuild = await readFile(PKGBUILD_TEMPLATE, "utf-8");

  pkgbuild = pkgbuild.replace(
    /^_electronversion=\d+$/m,
    `_electronversion=${electronMajor}`
  );
  pkgbuild = pkgbuild.replace(/^pkgver=.*$/m, `pkgver=${pkgver}`);
  pkgbuild = pkgbuild.replace(
    /^sha256sums_x86_64=\('.*'\)$/m,
    `sha256sums_x86_64=('${sha256_amd64}')`
  );
  pkgbuild = pkgbuild.replace(
    /^sha256sums_aarch64=\('.*'\)$/m,
    `sha256sums_aarch64=('${sha256_arm64}')`
  );

  // ── Write output ────────────────────────────────────────────────────
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(resolve(OUT_DIR, "PKGBUILD"), pkgbuild);
  await cp(resolve(extractDir, "LICENSE"), resolve(OUT_DIR, "LICENSE"));

  console.log(`\nDone. PKGBUILD written to ${OUT_DIR}/PKGBUILD`);
  console.log(`  pkgver:            ${pkgver}`);
  console.log(`  _electronversion:  ${electronMajor}`);
  console.log(`  sha256sums_x86_64: ${sha256_amd64}`);
  console.log(`  sha256sums_aarch64:${sha256_arm64}`);
  console.log(`  LICENSE from:      release tarball`);
} finally {
  await rm(tmpTarball, { force: true });
  await rm(extractDir, { recursive: true, force: true });
}
