#!/usr/bin/env node
/**
 * Rebuild the Squirrel installer around a signed package, then verify it.
 *
 * `pnpm make` produces three things that have to agree with each other:
 *
 *   - `*-full.nupkg` — the package SignPath signs in the second signing pass,
 *   - `RELEASES` — one line per release carrying that package's SHA1 and size,
 *   - `<name>-<version> Setup.exe` — the installer, which embeds *its own copy*
 *     of the package, of `Update.exe`, and of the inner `RELEASES`.
 *
 * Signing rewrites the package, so the copy inside the installer is stale: a
 * fresh install would extract an unsigned updater and launcher stub from it.
 * `repack` therefore swaps in the signed package, rebuilds the installer's
 * payload from it and rewrites `RELEASES`. `verify` then proves the published
 * installer carries the signed package and that the updater, the launcher stub
 * and the installer itself are all Authenticode-signed.
 *
 * The embed step reuses Squirrel's own `WriteZipToSetup.exe`, which *replaces*
 * the payload of the file it is given and leaves the version resources that
 * `rcedit` applied (product name, file version, copyright, icon) untouched, so
 * neither the installer's metadata nor its name has to be reproduced here.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import unzipper from "unzipper";

import { runStreaming } from "../packaging/common/process.ts";
import { metadata } from "../packaging/resources/metadata.ts";

const ROOT = resolve(import.meta.dirname, "..");
const SQUIRREL_OUT = join(ROOT, "out", "make", "squirrel.windows");
const VENDOR = join(ROOT, "node_modules", "electron-winstaller", "vendor");

/** Squirrel's own payload writer. */
const WRITE_ZIP_TO_SETUP = join(VENDOR, "WriteZipToSetup.exe");
/** Stands in for the zip writer .NET uses in Squirrel (`ZipFile.CreateFromDirectory`). */
const SEVEN_ZIP = join(VENDOR, "7z.exe");
/** What `electron-winstaller` always passes as `--loadingGif`. */
const LOADING_GIF = join(
  ROOT,
  "node_modules",
  "electron-winstaller",
  "resources",
  "install-spinner.gif"
);

/** Signatures Squirrel writes: UTF-8 BOM, then `SHA1 NAME SIZE`, no trailing newline. */
const RELEASES_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UPDATER_ENTRY = "lib/net45/squirrel.exe";
const STUB_ENTRY = /^lib\/net45\/[^/]+_ExecutionStub\.exe$/i;
/** The executables Squirrel puts in the package root, all of which must be signed. */
const PACKAGE_ROOT_EXE = /^lib\/net45\/[^/]+\.exe$/i;

const log = (message: string) => console.log(`[repack-squirrel] ${message}`);

function fail(message: string): never {
  throw new Error(message);
}

async function hash(file: string, algorithm: "sha1" | "sha256"): Promise<string> {
  return createHash(algorithm)
    .update(await readFile(file))
    .digest("hex")
    .toUpperCase();
}

async function sizeOf(file: string): Promise<number> {
  return (await stat(file)).size;
}

/**
 * True when the PE carries a non-empty Authenticode certificate table.
 *
 * This deliberately checks for the *presence* of a signature instead of
 * validating its trust chain: the signing policy in use issues test
 * certificates, which the build agent does not trust.
 */
async function isAuthenticodeSigned(file: string): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    const dos = Buffer.alloc(0x40);
    await handle.read(dos, 0, dos.length, 0);
    if (dos.readUInt16LE(0) !== 0x5a4d) return false; // "MZ"
    const peOffset = dos.readUInt32LE(0x3c);
    const coff = Buffer.alloc(0x18);
    await handle.read(coff, 0, coff.length, peOffset);
    if (coff.readUInt32LE(0) !== 0x00004550) return false; // "PE\0\0"
    const optional = Buffer.alloc(2);
    await handle.read(optional, 0, 2, peOffset + 0x18);
    const dataDirectories = peOffset + 0x18 + (optional.readUInt16LE(0) === 0x20b ? 112 : 96);
    // Data directory 4 is the certificate table; its second dword is the size.
    const certificateTable = Buffer.alloc(8);
    await handle.read(certificateTable, 0, 8, dataDirectories + 4 * 8);
    return certificateTable.readUInt32LE(4) > 0;
  } finally {
    await handle.close();
  }
}

async function assertSigned(files: string[], description: string): Promise<void> {
  for (const file of files) {
    if (!(await isAuthenticodeSigned(file))) {
      fail(`${description}: ${basename(file)} is not Authenticode-signed`);
    }
    log(`signed: ${basename(file)}`);
  }
}

/**
 * Slice the zip payload out of a Squirrel installer.
 *
 * `WriteZipToSetup.exe` stores the payload as a PE section rather than after
 * the image, so the archive is located through its end-of-central-directory
 * record: the central directory sits directly before it, which fixes the
 * offset the archive starts at.
 */
async function readEmbeddedPayload(installer: string): Promise<Buffer> {
  const file = await readFile(installer);
  const earliest = Math.max(0, file.length - 65536);
  let eocd = -1;
  for (let offset = file.length - 22; offset >= earliest; offset--) {
    if (file.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) fail(`${basename(installer)} has no embedded zip payload`);

  const centralDirectorySize = file.readUInt32LE(eocd + 12);
  const centralDirectoryOffset = file.readUInt32LE(eocd + 16);
  const start = eocd - centralDirectorySize - centralDirectoryOffset;
  if (start < 0 || file.readUInt32LE(start) !== 0x04034b50) {
    fail(`could not locate the zip payload inside ${basename(installer)}`);
  }
  return file.subarray(start, eocd + 22);
}

async function listMatching(dir: string, pattern: RegExp): Promise<string[]> {
  const names = await readdir(dir).catch(() => fail(`cannot read directory ${dir}`));
  return names
    .filter((name) => pattern.test(name))
    .map((name) => join(dir, name))
    .sort();
}

async function singleMatch(dir: string, pattern: RegExp, description: string): Promise<string> {
  const matches = await listMatching(dir, pattern);
  if (matches.length !== 1) {
    fail(`expected exactly one ${description} in ${dir}, found ${matches.length}`);
  }
  return matches[0];
}

/** The `out/make/squirrel.windows/<arch>` directory holding a packaged release. */
async function findReleaseDir(explicit?: string): Promise<string> {
  if (explicit) return resolve(explicit);
  const entries = await readdir(SQUIRREL_OUT, { withFileTypes: true }).catch(() =>
    fail(`cannot read ${SQUIRREL_OUT} — run \`pnpm make\` first`)
  );
  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(SQUIRREL_OUT, entry.name);
    if ((await listMatching(dir, /-full\.nupkg$/)).length > 0) candidates.push(dir);
  }
  if (candidates.length !== 1) {
    fail(`expected exactly one squirrel release directory, found ${candidates.length}`);
  }
  return candidates[0];
}

/** `SHA1 NAME SIZE` for one package — the only line Squirrel writes for a fresh release. */
function releasesLine(name: string, sha1: string, size: number): string {
  return `${sha1.toUpperCase()} ${name} ${size}`;
}

function releasesBytes(lines: string[]): Buffer {
  return Buffer.concat([RELEASES_BOM, Buffer.from(lines.join("\n"), "utf8")]);
}

/**
 * Rewrite `RELEASES` so the entry for `name` carries the current hash and size.
 *
 * Builds keep a single release, so this normally rewrites the whole file, but
 * any other entries (a delta, a previous version) are preserved verbatim.
 */
async function writeReleases(file: string, line: string, name: string): Promise<void> {
  const existing = await readFile(file).catch(() => null);
  const lines = existing
    ? existing
        .toString("utf8")
        .replace(/^\uFEFF/, "")
        .split("\n")
        .filter((entry) => entry.trim() !== "")
    : [];
  const index = lines.findIndex((entry) => entry.trim().split(/\s+/)[1] === name);
  if (index >= 0) lines[index] = line;
  else lines.push(line);
  await writeFile(file, releasesBytes(lines));
  log(`RELEASES describes ${name}`);
}

async function assertReleases(file: string, packageFile: string): Promise<void> {
  const name = basename(packageFile);
  const text = (await readFile(file)).toString("utf8").replace(/^\uFEFF/, "");
  const entry = text
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === name);
  if (!entry) fail(`${basename(file)} has no entry for ${name}`);

  const [expectedSha1, , expectedSize] = entry;
  const actualSha1 = await hash(packageFile, "sha1");
  const actualSize = await sizeOf(packageFile);
  if (expectedSha1.toUpperCase() !== actualSha1 || Number(expectedSize) !== actualSize) {
    fail(
      `${basename(file)} does not describe ${name}: ` +
        `expected ${expectedSha1} ${expectedSize}, found ${actualSha1} ${actualSize}`
    );
  }
  log(`RELEASES matches ${name}`);
}

/** Prove an installer embeds `packageFile` and a signed updater. */
async function assertInstallerPayload(
  installer: string,
  packageFile: string,
  workDir: string
): Promise<void> {
  const payload = await readEmbeddedPayload(installer);
  const zip = await unzipper.Open.buffer(payload);

  const embedded = zip.files.find((entry) => entry.path.endsWith("-full.nupkg"));
  if (!embedded) fail(`${basename(installer)} does not embed a package`);

  const embeddedFile = join(workDir, basename(embedded.path));
  await writeFile(embeddedFile, await embedded.buffer());
  if ((await hash(embeddedFile, "sha256")) !== (await hash(packageFile, "sha256"))) {
    fail(`${basename(installer)} embeds a different package than ${basename(packageFile)}`);
  }
  log(`installer payload carries the signed package (${basename(packageFile)})`);

  const updater = zip.files.find((entry) => entry.path === "Update.exe");
  if (!updater) fail(`${basename(installer)} does not embed Update.exe`);
  const updaterFile = join(workDir, "payload-Update.exe");
  await writeFile(updaterFile, await updater.buffer());
  await assertSigned([updaterFile], "the updater embedded in the installer");

  const releases = zip.files.find((entry) => entry.path === "RELEASES");
  if (!releases) fail(`${basename(installer)} does not embed RELEASES`);
  const releasesFile = join(workDir, "payload-RELEASES");
  await writeFile(releasesFile, await releases.buffer());
  await assertReleases(releasesFile, packageFile);
}

/**
 * SignPath signs the package, so swap it in, rebuild the installer around it and
 * make `RELEASES` describe it.
 */
async function repack(options: { signedNupkgDir: string; releaseDir?: string }): Promise<void> {
  if (process.platform !== "win32") fail("the Squirrel installer can only be rebuilt on Windows");

  const releaseDir = await findReleaseDir(options.releaseDir);
  const installedNupkg = await singleMatch(releaseDir, /-full\.nupkg$/, "release package");
  const installer = await singleMatch(releaseDir, /Setup\.exe$/i, "installer");
  const signedNupkg = await singleMatch(options.signedNupkgDir, /-full\.nupkg$/, "signed package");

  if (basename(signedNupkg) !== basename(installedNupkg)) {
    fail(
      `the signed package is named ${basename(signedNupkg)} but the release has ` +
        `${basename(installedNupkg)} — SignPath must return the package under its original name`
    );
  }

  const archive = await unzipper.Open.file(signedNupkg);
  const updaterEntry = archive.files.find((entry) => entry.path === UPDATER_ENTRY);
  const stubEntry = archive.files.find((entry) => STUB_ENTRY.test(entry.path));
  if (!updaterEntry) fail(`${basename(signedNupkg)} has no ${UPDATER_ENTRY}`);
  if (!stubEntry) fail(`${basename(signedNupkg)} has no launcher stub`);

  const workDir = await mkdtemp(join(tmpdir(), "squirrel-repack-"));
  try {
    const signedUpdater = join(workDir, "Update.exe");
    await writeFile(signedUpdater, await updaterEntry.buffer());
    const signedStub = join(workDir, basename(stubEntry.path));
    await writeFile(signedStub, await stubEntry.buffer());
    await assertSigned([signedUpdater, signedStub], "the binaries Squirrel added to the package");

    // The signed package replaces the unsigned one it was built from.
    await copyFile(signedNupkg, installedNupkg);

    const name = basename(installedNupkg);
    const line = releasesLine(
      name,
      await hash(installedNupkg, "sha1"),
      await sizeOf(installedNupkg)
    );

    // The payload is the same set of files Squirrel's own `createSetupEmbeddedZip`
    // writes, except that the updater is the signed one from inside the package
    // (it carries the configured icon, which the pristine vendor copy does not).
    const payloadDir = join(workDir, "payload");
    await mkdir(payloadDir);
    await copyFile(installedNupkg, join(payloadDir, name));
    await copyFile(signedUpdater, join(payloadDir, "Update.exe"));
    await writeFile(join(payloadDir, "RELEASES"), releasesBytes([line]));
    const setupIcon = join(ROOT, metadata.squirrel.setupIcon);
    if (existsSync(LOADING_GIF)) await copyFile(LOADING_GIF, join(payloadDir, "background.gif"));
    if (existsSync(setupIcon)) await copyFile(setupIcon, join(payloadDir, "setupIcon.ico"));

    const payloadZip = join(workDir, "payload.zip");
    await runStreaming(SEVEN_ZIP, ["a", "-tzip", "-mx=5", payloadZip, "*"], { cwd: payloadDir });

    const payload = await unzipper.Open.file(payloadZip);
    const archived = payload.files.map((entry) => entry.path).sort();
    const expected = (await readdir(payloadDir)).sort();
    if (archived.join("\n") !== expected.join("\n")) {
      fail(`payload archive holds [${archived.join(", ")}] instead of [${expected.join(", ")}]`);
    }

    await runStreaming(WRITE_ZIP_TO_SETUP, [installer, payloadZip]);
    log(`rebuilt ${basename(installer)}`);

    await writeReleases(join(releaseDir, "RELEASES"), line, name);
    await assertInstallerPayload(installer, installedNupkg, workDir);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  if (process.env.GITHUB_OUTPUT) {
    // Forward slashes keep the value usable both as an artifact glob and as an
    // action input, which are separator-agnostic on Windows.
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `release-dir=${releaseDir.replaceAll("\\", "/")}\n`
    );
  }
}

/** Check everything the release job is about to publish. */
async function verify(options: { releaseDir?: string }): Promise<void> {
  const releaseDir = await findReleaseDir(options.releaseDir);
  const packageFile = await singleMatch(releaseDir, /-full\.nupkg$/, "release package");
  const installer = await singleMatch(releaseDir, /Setup\.exe$/i, "installer");

  // Every executable in the package root is signed by one of the two passes.
  const archive = await unzipper.Open.file(packageFile);
  const rootExecutables = archive.files.filter((entry) => PACKAGE_ROOT_EXE.test(entry.path));
  if (rootExecutables.length === 0) fail(`${basename(packageFile)} holds no executables`);

  const workDir = await mkdtemp(join(tmpdir(), "squirrel-verify-"));
  try {
    const extracted: string[] = [];
    for (const entry of rootExecutables) {
      const file = join(workDir, basename(entry.path));
      await writeFile(file, await entry.buffer());
      extracted.push(file);
    }
    await assertSigned(extracted, "the executables in the package");
    await assertSigned([installer], "the installer");
    await assertInstallerPayload(installer, packageFile, workDir);
    await assertReleases(join(releaseDir, "RELEASES"), packageFile);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  log(`verified the signed release in ${releaseDir}`);
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "signed-nupkg": { type: "string" },
    "release-dir": { type: "string" },
  },
  allowPositionals: true,
});

try {
  switch (positionals[0]) {
    case "repack": {
      if (!values["signed-nupkg"]) fail("repack needs --signed-nupkg <directory>");
      await repack({
        signedNupkgDir: resolve(values["signed-nupkg"]),
        releaseDir: values["release-dir"],
      });
      break;
    }
    case "verify": {
      await verify({ releaseDir: values["release-dir"] });
      break;
    }
    default: {
      fail("usage: repack-squirrel.ts <repack --signed-nupkg DIR | verify> [--release-dir DIR]");
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // A stack trace here would only bury the file names that explain the failure.
  console.error(`::error::${message}`);
  process.exitCode = 1;
}
