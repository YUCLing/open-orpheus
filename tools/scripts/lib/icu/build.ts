import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync, type ExecSyncOptions } from "child_process";
import { pipeline } from "stream/promises";

import got from "got";

import { die, log, type BuildOptions, type VersionOptions } from "./cli.ts";
import {
  buildIcuUrls,
  detectIcuMajorVersion,
  determineBuildVersion,
  resolveVersion,
  type DetectedVersion,
  type IcuUrls,
} from "./version.ts";

const VERSION_MARKER = ".icu-version";
const PREPARED_MARKER = ".icu-prepared";

async function downloadFile(url: string, dest: string): Promise<void> {
  log(`Downloading ${url}`);
  await pipeline(got.stream(url), fs.createWriteStream(dest));
}

function runCommand(command: string, options: ExecSyncOptions = {}): void {
  log(`Running: ${command}`);
  try {
    execSync(command, { stdio: "inherit", ...options });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    die(`Command failed: ${command}\n${message}`);
  }
}

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

export async function cmdVersion(options: VersionOptions): Promise<void> {
  const major = detectIcuMajorVersion(options.inputDat);

  if (options.full) {
    const version = await resolveVersion(major);
    process.stdout.write(version.full + "\n");
  } else {
    process.stdout.write(major + "\n");
  }
}

export async function cmdBuild(options: BuildOptions): Promise<void> {
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
