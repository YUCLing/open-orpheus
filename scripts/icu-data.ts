#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync, type ExecSyncOptions } from "child_process";
import { pipeline } from "stream/promises";
import got from "got";

// ------------------------------------------------------------------
// Types & Interfaces
// ------------------------------------------------------------------

interface VersionOptions {
  inputDat: string;
  full: boolean;
}

interface BuildOptions {
  inputDat: string | null;
  icuVersion: string | null;
  filterFile: string;
  outputDat: string;
  buildDir: string | null;
}

interface DetectedVersion {
  full: string;
  major: number;
  minor: number;
}

interface IcuUrls {
  source: string;
  data: string;
}

interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
}

const VERSION_MARKER = ".icu-version";
const PREPARED_MARKER = ".icu-prepared";

// ------------------------------------------------------------------
// Logging & Error Handling
// ------------------------------------------------------------------

// All log output goes to stderr so that stdout can carry clean
// machine-readable values (e.g. the version number).
function log(message: string): void {
  console.error(`[${new Date().toISOString()}] ${message}`);
}

function die(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

// ------------------------------------------------------------------
// Argument Parsing
// ------------------------------------------------------------------

interface ParsedArgs {
  command: string;
  flags: Map<string, string>;
  booleans: Set<string>;
}

function parseArgv(argv: string[]): ParsedArgs {
  const [command = "", ...rest] = argv;
  const flags = new Map<string, string>();
  const booleans = new Set<string>();

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) continue;

    const name = arg.slice(2);
    const next = rest[i + 1];

    if (next === undefined || next.startsWith("--")) {
      booleans.add(name);
    } else {
      flags.set(name, next);
      i++;
    }
  }

  return { command, flags, booleans };
}

function parseVersionOptions(args: ParsedArgs): VersionOptions {
  return {
    inputDat: args.flags.get("input") ?? "icudtl.dat",
    full: args.booleans.has("full"),
  };
}

function parseBuildOptions(args: ParsedArgs): BuildOptions {
  const rawBuildDir = args.flags.get("build-dir") ?? "";
  const rawIcuVersion = args.flags.get("icu-version") ?? null;

  if (rawIcuVersion !== null && !/^\d+(\.\d+)?$/.test(rawIcuVersion)) {
    die(
      `--icu-version must be a major version (e.g. "78") or a full ` +
        `version (e.g. "78.3"), got: ${rawIcuVersion}`
    );
  }

  return {
    inputDat: args.flags.get("input") ?? null,
    icuVersion: rawIcuVersion,
    filterFile: args.flags.get("filter") ?? "filters.json",
    outputDat: args.flags.get("output") ?? "icudtl.dat",
    buildDir: rawBuildDir ? path.resolve(rawBuildDir) : null,
  };
}

function printUsage(): void {
  const usage = `
Usage:
  build-icu version [--input <file>] [--full]
  build-icu build   (--input <file> | --icu-version <version>) [options]

Commands:
  version   Print the ICU major version embedded in a .dat file.
            With --full, also resolve the exact release tag (e.g. "78.3")
            via the GitHub releases API.

  build     Build a custom icudtl.dat from ICU sources, filtered by the
            given config. The ICU version is taken from either --input
            (read from an existing .dat file) or --icu-version (given
            directly). If --build-dir is supplied, the extracted sources
            and object files are preserved for reuse across runs;
            otherwise a temporary directory is created and removed.

Build input (exactly one required):
  --input <file>          Path to an existing ICU .dat file. The major
                          version is detected from its TOC prefix.
  --icu-version <ver>     ICU version to build. Accepts a major version
                          ("78") — the exact release is resolved via the
                          GitHub releases API — or a full version
                          ("78.3") which skips the lookup entirely.

Build options:
  --filter <file>         Path to the ICU Data Build Tool filter JSON
                                                          (default: filters.json)
  --output <file>         Where to write the built .dat file (default: icudtl.dat)
  --build-dir <dir>       Explicit build directory, owned exclusively by
                          this script and preserved across runs; its
                          contents may be wiped without confirmation

Other:
  -h, --help              Show this help text
`.trim();
  console.log(usage);
}

// ------------------------------------------------------------------
// Version Detection (local, from the binary header)
// ------------------------------------------------------------------

/**
 * Detect the ICU major version by scanning the .dat file for its
 * internal TOC prefix pattern: "icudt<digits>l/" or "icudt<digits>b/".
 *
 * The `dataVersion` field in the binary header is NOT the ICU release
 * version for all files (e.g. it can be 3.0.0.0 for the "CmnD" format).
 * The TOC prefix is the authoritative source.
 */
function detectIcuMajorVersion(filePath: string): number {
  if (!fs.existsSync(filePath)) {
    die(`Input file not found: ${filePath}`);
  }

  const stat = fs.statSync(filePath);
  const scanSize = Math.min(stat.size, 4 * 1024 * 1024);
  const buffer = Buffer.alloc(scanSize);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buffer, 0, scanSize, 0);
  } finally {
    fs.closeSync(fd);
  }

  if (scanSize >= 4) {
    const magic1 = buffer.readUInt8(2);
    const magic2 = buffer.readUInt8(3);
    if (magic1 !== 0xda || magic2 !== 0x27) {
      die(`Invalid magic bytes in ${filePath}. Not a valid ICU .dat file.`);
    }
  }

  const text = buffer.toString("latin1");
  const match = text.match(/icudt(\d+)[lb]\//);
  if (!match) {
    die(
      `Could not find an ICU TOC prefix (e.g. "icudt78l/") in the first ` +
        `${scanSize} bytes of ${filePath}.`
    );
  }

  const major = parseInt(match[1], 10);
  if (!Number.isFinite(major) || major < 1 || major > 999) {
    die(`Parsed an implausible ICU major version: ${match[1]}`);
  }

  return major;
}

// ------------------------------------------------------------------
// Version Resolution (remote, via GitHub releases API)
// ------------------------------------------------------------------

/**
 * Query the GitHub releases API to find the highest release tag matching
 * the given ICU major version. Returns e.g. "78.3".
 */
async function findIcuReleaseTag(major: number): Promise<string> {
  log(`Querying GitHub releases API for ICU ${major}.x ...`);

  const releases = await got
    .get("https://api.github.com/repos/unicode-org/icu/releases", {
      searchParams: { per_page: "100" },
      headers: {
        "User-Agent": "build-custom-icu",
        Accept: "application/vnd.github+json",
      },
    })
    .json<GitHubRelease[]>();

  const candidates = releases
    .filter((r) => !r.draft && !r.prerelease)
    .map((r) => r.tag_name.match(/^release-(\d+)\.(\d+)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ major: parseInt(m[1], 10), minor: parseInt(m[2], 10) }))
    .filter((v) => v.major === major);

  if (candidates.length === 0) {
    throw new Error(`No ICU release found for major version ${major}`);
  }

  candidates.sort((a, b) => b.minor - a.minor);
  const best = candidates[0];
  return `${best.major}.${best.minor}`;
}

async function resolveVersion(major: number): Promise<DetectedVersion> {
  const full = await findIcuReleaseTag(major);
  return {
    full,
    major,
    minor: parseInt(full.split(".")[1], 10),
  };
}

/**
 * Resolve the ICU version to build, from either an explicit --icu-version
 * or by reading the major version out of --input and looking up the rest.
 */
async function determineBuildVersion(options: BuildOptions): Promise<DetectedVersion> {
  if (options.icuVersion) {
    const parts = options.icuVersion.split(".");
    const major = parseInt(parts[0], 10);

    if (parts.length > 1) {
      // Full version supplied — skip the GitHub lookup entirely.
      const minor = parseInt(parts[1], 10);
      const version: DetectedVersion = { full: options.icuVersion, major, minor };
      log(`Using exact ICU version from --icu-version: ${version.full}`);
      return version;
    }

    log(`Using ICU major version from --icu-version: ${major}`);
    const version = await resolveVersion(major);
    log(`Resolved ICU release: ${version.full}`);
    return version;
  }

  if (options.inputDat) {
    const major = detectIcuMajorVersion(options.inputDat);
    log(`Detected ICU major version from ${options.inputDat}: ${major}`);
    const version = await resolveVersion(major);
    log(`Resolved ICU release: ${version.full}`);
    return version;
  }

  die("build requires either --input <file> or --icu-version <major>");
}

// ------------------------------------------------------------------
// Download Helper
// ------------------------------------------------------------------

async function downloadFile(url: string, dest: string): Promise<void> {
  log(`Downloading ${url}`);
  await pipeline(got.stream(url), fs.createWriteStream(dest));
}

// ------------------------------------------------------------------
// Shell Execution
// ------------------------------------------------------------------

function runCommand(command: string, options: ExecSyncOptions = {}): void {
  log(`Running: ${command}`);
  try {
    execSync(command, { stdio: "inherit", ...options });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    die(`Command failed: ${command}\n${message}`);
  }
}

// ------------------------------------------------------------------
// URL Construction
// ------------------------------------------------------------------

function buildIcuUrls(version: DetectedVersion): IcuUrls {
  const baseUrl = `https://github.com/unicode-org/icu/releases/download/release-${version.full}`;
  return {
    source: `${baseUrl}/icu4c-${version.full}-sources.tgz`,
    data: `${baseUrl}/icu4c-${version.full}-data.zip`,
  };
}

// ------------------------------------------------------------------
// File System Helpers
// ------------------------------------------------------------------

function findBuiltDataFile(outDir: string, expectedName: string): string {
  if (!fs.existsSync(outDir)) {
    die(`Output directory not found: ${outDir}`);
  }
  const files = fs.readdirSync(outDir);
  const match = files.find((f) => f === expectedName);
  if (!match) {
    die(
      `Could not find built data file "${expectedName}" in ${outDir}. Contents: ${files.join(", ")}`
    );
  }
  return path.join(outDir, match);
}

/**
 * Breadth-first search for the directory containing locales/root.txt.
 * The ICU data zip has varied its internal layout across releases.
 */
function findExtractedDataDir(root: string): string | null {
  const queue: string[] = [root];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const localesEntry = entries.find((e) => e.isDirectory() && e.name === "locales");
    if (localesEntry) {
      const localesDir = path.join(dir, "locales");
      if (fs.existsSync(path.join(localesDir, "root.txt"))) {
        return dir;
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        queue.push(path.join(dir, entry.name));
      }
    }
  }
  return null;
}

/**
 * Prepare the build directory. Idempotent: safe to re-run after a partial
 * failure. Writes `.icu-prepared` on success so subsequent runs skip
 * download, extraction, and data-tree setup entirely.
 *
 * Must be called with the CWD already set to the build directory.
 */
async function setupBuildDir(urls: IcuUrls): Promise<void> {
  if (fs.existsSync(PREPARED_MARKER)) {
    log("Build directory already prepared; skipping download and extraction.");
    return;
  }

  if (!fs.existsSync("icu-sources.tgz")) {
    await downloadFile(urls.source, "icu-sources.tgz");
  } else {
    log("Reusing existing icu-sources.tgz");
  }
  if (!fs.existsSync("icu-data.zip")) {
    await downloadFile(urls.data, "icu-data.zip");
  } else {
    log("Reusing existing icu-data.zip");
  }

  if (!fs.existsSync("icu/source/runConfigureICU")) {
    log("Extracting source archive...");
    runCommand("tar xzf icu-sources.tgz");
  } else {
    log("Source already extracted; skipping.");
  }

  if (!fs.existsSync("icu/source/data/locales/root.txt")) {
    let extractedDataDir = findExtractedDataDir(".");

    if (!extractedDataDir) {
      log("Extracting data archive...");
      runCommand("unzip -q icu-data.zip");
      extractedDataDir = findExtractedDataDir(".");
    } else {
      log("Data already extracted; skipping extraction.");
    }

    if (!extractedDataDir) {
      die("Could not locate extracted ICU data (no locales/root.txt found).");
    }

    const source = path.resolve(extractedDataDir);
    const target = path.resolve("icu/source/data");

    if (source !== target) {
      log(`Moving ${extractedDataDir} -> icu/source/data`);
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(source, target);
    } else {
      log("Data already in place at icu/source/data.");
    }
  }

  if (!fs.existsSync("icu/source/data/locales/root.txt")) {
    die('Critical data source "icu/source/data/locales/root.txt" is missing after extraction.');
  }

  const inDir = "icu/source/data/in";
  if (fs.existsSync(inDir)) {
    const datFiles = fs.readdirSync(inDir).filter((f) => f.endsWith(".dat"));
    if (datFiles.length > 0) {
      log(`Cleaning pre-built .dat files from ${inDir}: ${datFiles.join(", ")}`);
      for (const file of datFiles) {
        fs.unlinkSync(path.join(inDir, file));
      }
    }
  }

  fs.writeFileSync(PREPARED_MARKER, "ok\n");
  log("Build directory prepared.");
}

// ------------------------------------------------------------------
// Build Directory Selection
// ------------------------------------------------------------------

interface ChosenBuildDir {
  path: string;
  isTemporary: boolean;
}

function chooseBuildDir(options: BuildOptions, version: DetectedVersion): ChosenBuildDir {
  if (options.buildDir) {
    const buildDir = options.buildDir;
    fs.mkdirSync(buildDir, { recursive: true });

    const versionFile = path.join(buildDir, VERSION_MARKER);
    if (fs.existsSync(versionFile)) {
      const existing = fs.readFileSync(versionFile, "utf8").trim();
      if (existing !== version.full) {
        log(`Build dir was for ICU ${existing}, need ${version.full} — wiping contents.`);
        for (const entry of fs.readdirSync(buildDir)) {
          fs.rmSync(path.join(buildDir, entry), { recursive: true, force: true });
        }
      }
    }
    fs.writeFileSync(versionFile, version.full + "\n");

    return { path: buildDir, isTemporary: false };
  }

  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "icu-build-"));
  fs.writeFileSync(path.join(buildDir, VERSION_MARKER), version.full + "\n");
  return { path: buildDir, isTemporary: true };
}

// ------------------------------------------------------------------
// Command: version
// ------------------------------------------------------------------

async function cmdVersion(options: VersionOptions): Promise<void> {
  const major = detectIcuMajorVersion(options.inputDat);

  if (options.full) {
    const version = await resolveVersion(major);
    process.stdout.write(version.full + "\n");
  } else {
    process.stdout.write(major + "\n");
  }
}

// ------------------------------------------------------------------
// Command: build
// ------------------------------------------------------------------

async function cmdBuild(options: BuildOptions): Promise<void> {
  if (!fs.existsSync(options.filterFile)) {
    die(`Filter file not found: ${options.filterFile}`);
  }

  if (options.inputDat && options.icuVersion) {
    die("Cannot specify both --input and --icu-version; pick one.");
  }

  const absoluteFilterFile = path.resolve(options.filterFile);
  const absoluteOutputDat = path.resolve(options.outputDat);

  const version = await determineBuildVersion(options);

  const urls = buildIcuUrls(version);
  const buildDir = chooseBuildDir(options, version);
  log(
    `Build directory: ${buildDir.path}` +
      (buildDir.isTemporary ? " (temporary, will be removed)" : " (explicit, will be preserved)")
  );

  const originalCwd = process.cwd();

  try {
    process.chdir(buildDir.path);
    await setupBuildDir(urls);

    process.chdir("icu/source");

    const dataOut = "data/out";
    if (fs.existsSync(dataOut)) {
      log(`Clearing stale data build output: ${dataOut}`);
      fs.rmSync(dataOut, { recursive: true, force: true });
    }

    log("Configuring ICU with filter...");
    const configureEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ICU_DATA_FILTER_FILE: absoluteFilterFile,
    };
    runCommand("./runConfigureICU Linux --with-data-packaging=archive", { env: configureEnv });

    log("Building ICU (this may take several minutes)...");
    runCommand(`make -j${os.cpus().length}`);

    const expectedDatName = `icudt${version.major}l.dat`;
    const builtDatPath = findBuiltDataFile("data/out", expectedDatName);

    log(`Copying ${builtDatPath} to ${absoluteOutputDat}...`);
    fs.copyFileSync(builtDatPath, absoluteOutputDat);

    log("✅ Build successful!");
    log(`   Custom ICU data file: ${absoluteOutputDat}`);
  } finally {
    process.chdir(originalCwd);

    if (buildDir.isTemporary) {
      log(`Removing temporary build directory: ${buildDir.path}`);
      fs.rmSync(buildDir.path, { recursive: true, force: true });
    } else {
      log(`Build directory preserved: ${buildDir.path}`);
    }
  }
}

// ------------------------------------------------------------------
// Entry Point
// ------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    printUsage();
    process.exit(argv.length === 0 ? 1 : 0);
  }

  const args = parseArgv(argv);

  switch (args.command) {
    case "version": {
      await cmdVersion(parseVersionOptions(args));
      break;
    }
    case "build": {
      await cmdBuild(parseBuildOptions(args));
      break;
    }
    default: {
      console.error(`ERROR: Unknown command: ${args.command}`);
      printUsage();
      process.exit(1);
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  die(message);
});
