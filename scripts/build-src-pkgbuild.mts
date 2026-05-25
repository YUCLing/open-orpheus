import { resolve, dirname } from "node:path";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { createWriteStream, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import got from "got";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const GITHUB_REPO = "YUCLing/open-orpheus";
const PKGBUILD_TEMPLATE = resolve(projectRoot, "packaging/aur/src/PKGBUILD");
const OUT_DIR = resolve(projectRoot, "out/make/aur/src");

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
}>();

const tagName = release.tag_name; // e.g. "v0.12.2"
const pkgver = tagName.replace(/^v/, ""); // e.g. "0.12.2"
console.log(`Release tag: ${tagName}, pkgver: ${pkgver}`);

// ── Download source tarball and compute SHA256 ────────────────────────
const srcUrl = `https://github.com/${GITHUB_REPO}/archive/refs/tags/${tagName}.tar.gz`;
const tmpTarball = resolve(tmpdir(), `pkgbuild-src-${tagName}.tar.gz`);

try {
  console.log(`Downloading source tarball: ${srcUrl}`);
  await pipeline(got.stream(srcUrl), createWriteStream(tmpTarball));

  // Compute SHA256 of the tarball
  const hash = createHash("sha256");
  await pipeline(createReadStream(tmpTarball), hash);
  const sha256 = hash.digest("hex");
  console.log(`SHA256: ${sha256}`);

  // ── Read and update PKGBUILD template ───────────────────────────────
  let pkgbuild = await readFile(PKGBUILD_TEMPLATE, "utf-8");

  pkgbuild = pkgbuild.replace(/^pkgver=.*$/m, `pkgver=${pkgver}`);
  pkgbuild = pkgbuild.replace(
    /^sha256sums=\('.*'\)$/m,
    `sha256sums=('${sha256}')`
  );

  // TODO: Generate utility files? e.g. desktop file

  // ── Write output ────────────────────────────────────────────────────
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(resolve(OUT_DIR, "PKGBUILD"), pkgbuild);

  console.log(`\nDone. PKGBUILD written to ${OUT_DIR}/PKGBUILD`);
  console.log(`  pkgver:    ${pkgver}`);
  console.log(`  sha256sums: ${sha256}`);
} finally {
  await rm(tmpTarball, { force: true });
}
