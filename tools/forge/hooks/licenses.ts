import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * Extract `LICENSES.chromium.html` to `EXTRACT_LICENSES_TO` when set, then
 * remove it from the build.
 */
export async function extractLicenses({
  buildPath,
  platform,
}: {
  buildPath: string;
  platform: string;
}): Promise<void> {
  const destDir = process.env.EXTRACT_LICENSES_TO;
  if (!destDir) return;

  const normalizedPlatform = platform === "mas" ? "darwin" : platform;
  const src = resolve(buildPath, "LICENSES.chromium.html");
  const dest = resolve(destDir, `LICENSES.chromium.${normalizedPlatform}.html`);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
  await rm(src);
}
