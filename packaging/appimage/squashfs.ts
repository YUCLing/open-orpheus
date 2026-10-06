import { execFileSync } from "node:child_process";

import { coerce } from "semver";

import { runStreaming } from "../common/process.ts";
import type { SemVer } from "semver";

export type SquashFsCompressor = "xz" | "gzip" | "lz4" | "lzo" | "zstd" | "lzma";

/**
 * The version of the `mksquashfs` on `PATH`, parsed from its `-version` output.
 * Throws when the binary is missing/unparsable, so callers fail before
 * squashing a multi-hundred-megabyte image.
 */
export function squashFsVersion(): SemVer {
  const output = (
    execFileSync("mksquashfs", ["-version"], {
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 768,
      windowsHide: true,
      env: { PATH: process.env["PATH"] },
    }).split("\n")[0] ?? ""
  ).trim();
  const version = coerce(/(?<=version )[0-9.]+/.exec(output)?.[0] ?? "");
  if (!version) {
    throw new Error(`Unable to parse a version out of \`mksquashfs -version\`: '${output}'.`);
  }
  return version;
}

export interface SquashFsOptions {
  /** Compressor passed to `-comp`. Defaults to the `mksquashfs` default (usually `gzip`). */
  compressor?: SquashFsCompressor | undefined;
}

/**
 * Squash `sourceDir` (the AppDir) into the SquashFS image `dest`.
 *
 * The AppImage runtime reads the unsigned image as-is, so the flags are chosen
 * to match what `appimagetool` produces — root ownership, no stale image
 * appended, and reproducible filesystem timestamps — while staying compatible
 * with the `mksquashfs` version actually installed (the `-all-time`/`-mkfs-time`
 * pair only exists in 4.4+, and `SOURCE_DATE_EPOCH` is honored by itself).
 */
export async function createSquashFs(
  sourceDir: string,
  dest: string,
  options: SquashFsOptions = {}
): Promise<string> {
  const version = squashFsVersion();
  const args = [sourceDir, dest];

  // -noappend (1.2+): overwrite any image left in the staging dir.
  if (version.compare("1.2.0") >= 0) args.push("-noappend");
  // -all-root (2.0+): every entry is owned by root, like in a real AppImage.
  if (version.compare("2.0.0") >= 0) args.push("-all-root");
  // -all-time/-mkfs-time (4.4+): zero the timestamps when the build does not
  // pin them through SOURCE_DATE_EPOCH (which mksquashfs honors on its own).
  if (version.compare("4.4.0") >= 0 && process.env["SOURCE_DATE_EPOCH"] === undefined) {
    args.push("-all-time", "0", "-mkfs-time", "0");
  }

  switch (options.compressor) {
    case undefined:
      break;
    // The xz defaults appimagetool uses: a full-size dictionary and small
    // blocks compress an AppImage noticeably better than the mksquashfs ones.
    case "xz":
      args.push("-Xdict-size", "100%", "-b", "16384", "-comp", "xz");
      break;
    default:
      args.push("-comp", options.compressor);
  }

  await runStreaming("mksquashfs", args);
  return dest;
}
