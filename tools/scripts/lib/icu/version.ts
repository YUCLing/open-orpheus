import * as fs from "fs";

import got from "got";

import { die, log, type BuildOptions } from "./cli.ts";

export interface DetectedVersion {
  full: string;
  major: number;
  minor: number;
}

export interface IcuUrls {
  source: string;
  data: string;
}

interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
}

/**
 * Detect the ICU major version by scanning the .dat file for its
 * internal TOC prefix pattern: "icudt<digits>l/" or "icudt<digits>b/".
 *
 * The `dataVersion` field in the binary header is NOT the ICU release
 * version for all files (e.g. it can be 3.0.0.0 for the "CmnD" format).
 * The TOC prefix is the authoritative source.
 */
export function detectIcuMajorVersion(filePath: string): number {
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

/**
 * Query the GitHub releases API to find the highest release tag matching
 * the given ICU major version. Returns e.g. "78.3".
 */
export async function findIcuReleaseTag(major: number): Promise<string> {
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

export async function resolveVersion(major: number): Promise<DetectedVersion> {
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
export async function determineBuildVersion(options: BuildOptions): Promise<DetectedVersion> {
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

export function buildIcuUrls(version: DetectedVersion): IcuUrls {
  const baseUrl = `https://github.com/unicode-org/icu/releases/download/release-${version.full}`;
  return {
    source: `${baseUrl}/icu4c-${version.full}-sources.tgz`,
    data: `${baseUrl}/icu4c-${version.full}-data.zip`,
  };
}
