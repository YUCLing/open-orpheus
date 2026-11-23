import * as path from "path";

// All log output goes to stderr so that stdout can carry clean
// machine-readable values (e.g. the version number).
export function log(message: string): void {
  console.error(`[${new Date().toISOString()}] ${message}`);
}

export function die(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

export interface VersionOptions {
  inputDat: string;
  full: boolean;
}

export interface BuildOptions {
  inputDat: string | null;
  icuVersion: string | null;
  filterFile: string;
  outputDat: string;
  buildDir: string | null;
}

export interface ParsedArgs {
  command: string;
  flags: Map<string, string>;
  booleans: Set<string>;
}

export function parseArgv(argv: string[]): ParsedArgs {
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

export function parseVersionOptions(args: ParsedArgs): VersionOptions {
  return {
    inputDat: args.flags.get("input") ?? "icudtl.dat",
    full: args.booleans.has("full"),
  };
}

export function parseBuildOptions(args: ParsedArgs): BuildOptions {
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

export function printUsage(): void {
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
