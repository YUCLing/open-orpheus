import { resolve, dirname } from "node:path";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { createWriteStream, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { execFile as execFileCb, spawn } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import got from "got";

const execFile = promisify(execFileCb);
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const { name: pkgname } = JSON.parse(
  await readFile(resolve(projectRoot, "package.json"), "utf-8")
);
const GITHUB_REPO = "YUCLing/open-orpheus";
const PKGBUILD_TEMPLATE = resolve(projectRoot, "packaging/aur/src/PKGBUILD");
const OUT_DIR = resolve(projectRoot, "out/make/aur/src");

// ── Parse source mode ────────────────────────────────────────────────
const sourceMode = process.argv[2] || "local";
const useLocalSource = sourceMode === "local";

let pkgver: string;
let srcUrl: string;
let sha256: string;
const sourceTarball = "source.tar.gz";
const sourceTarballPath = resolve(OUT_DIR, sourceTarball);

if (useLocalSource) {
  const localPkg = JSON.parse(
    await readFile(resolve(projectRoot, "package.json"), "utf-8")
  );
  pkgver = localPkg.version;

  console.log(
    `Using local source tree for PKGBUILD generation (pkgver ${pkgver}).`
  );

  await mkdir(OUT_DIR, { recursive: true });

  const { stdout: nullSeparatedFiles } = await execFile(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: projectRoot, maxBuffer: 10 * 1024 * 1024 }
  );

  console.log(`Creating local source tarball: ${sourceTarball}`);
  await new Promise<void>((res, rej) => {
    const tar = spawn(
      "tar",
      [
        "czf",
        sourceTarballPath,
        "--null",
        "--no-recursion",
        "--transform",
        `s,^,${pkgname}-${pkgver}/,`,
        "-C",
        projectRoot,
        "-T",
        "-",
      ],
      { cwd: projectRoot }
    );

    tar.on("error", rej);
    tar.on("close", (code) =>
      code === 0 ? res() : rej(new Error(`tar exited with code ${code}`))
    );
    tar.stdin.end(nullSeparatedFiles);
  });

  const hash = createHash("sha256");
  await pipeline(createReadStream(sourceTarballPath), hash);
  sha256 = hash.digest("hex");
  srcUrl = sourceTarball;
} else {
  const releaseName = sourceMode;
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
  pkgver = tagName.replace(/^v/, "");
  srcUrl = `https://github.com/${GITHUB_REPO}/archive/refs/tags/${tagName}.tar.gz`;
  const tmpTarball = resolve(tmpdir(), `pkgbuild-src-${tagName}.tar.gz`);

  try {
    console.log(`Downloading source tarball: ${srcUrl}`);
    await pipeline(got.stream(srcUrl), createWriteStream(tmpTarball));

    const hash = createHash("sha256");
    await pipeline(createReadStream(tmpTarball), hash);
    sha256 = hash.digest("hex");
  } finally {
    await rm(tmpTarball, { force: true });
  }
}

// ── Read and update PKGBUILD template ───────────────────────────────
let pkgbuild = await readFile(PKGBUILD_TEMPLATE, "utf-8");
pkgbuild = pkgbuild.replace(/^pkgver=.*$/m, `pkgver=${pkgver}`);
if (useLocalSource) {
  pkgbuild = pkgbuild.replace(/^source=.*$/m, `source=("${sourceTarball}")`);
} else {
  pkgbuild = pkgbuild.replace(
    /^source=.*$/m,
    `source=("${sourceTarball}::${srcUrl}")`
  );
}
pkgbuild = pkgbuild.replace(
  /^sha256sums=\('.*'\)$/m,
  `sha256sums=('${sha256}')`
);

await mkdir(OUT_DIR, { recursive: true });
await writeFile(resolve(OUT_DIR, "PKGBUILD"), pkgbuild);

console.log(`\nDone. PKGBUILD written to ${OUT_DIR}/PKGBUILD`);
console.log(`  pkgver:    ${pkgver}`);
console.log(`  sha256sums: ${sha256}`);
