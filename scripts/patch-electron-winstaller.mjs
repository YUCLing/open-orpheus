/**
 * Patches electron-winstaller for Windows ARM64 compatibility.
 *
 * electron-winstaller bundles 7-Zip binaries for ARM64 (7z-arm64.exe,
 * 7z-arm64.dll) but Squirrel.Windows's find7Zip() looks for "7z.exe"
 * and "7z.dll". This script creates those aliases so the Squirrel
 * installer maker works on Windows ARM64.
 */
import { copyFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const vendorDir = join(__dirname, "..", "node_modules", "electron-winstaller", "vendor");

const COPIES = [
  ["7z-arm64.exe", "7z.exe"],
  ["7z-arm64.dll", "7z.dll"],
];

async function main() {
  if (process.platform !== "win32" || process.arch !== "arm64") {
    console.log("[patch-electron-winstaller] Skipped: not on win32/arm64");
    return;
  }

  for (const [src, dest] of COPIES) {
    const srcPath = join(vendorDir, src);
    const destPath = join(vendorDir, dest);

    try {
      // Skip if destination already exists
      await access(destPath);
      console.log(`[patch-electron-winstaller] ${dest} already exists, skipping`);
    } catch {
      try {
        await copyFile(srcPath, destPath);
        console.log(`[patch-electron-winstaller] Copied ${src} -> ${dest}`);
      } catch (err) {
        console.error(`[patch-electron-winstaller] Failed to copy ${src} -> ${dest}: ${err.message}`);
        process.exitCode = 1;
      }
    }
  }
}

main();
