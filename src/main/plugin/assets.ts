import { realpath } from "node:fs/promises";
import path from "node:path";

import { sanitizeRelativePath } from "@main/util/path";

/**
 * Resolve an assets-relative path, returning null when it escapes the plugin's
 * assets directory.
 *
 * Directory trees are checked against real paths so symlinks cannot point
 * outside; asar paths are virtual and use lexical containment only.
 */
export async function resolvePluginAssetTarget(
  source: string,
  assetPath: string
): Promise<string | null> {
  const assetsRoot = path.join(source, "assets");
  const target = sanitizeRelativePath(assetsRoot, assetPath);
  if (target === false) return null;

  if (!source.endsWith(".asar")) {
    const realSource = await realpath(source);
    const expectedRoot = path.join(realSource, "assets");
    const realRoot = await realpath(expectedRoot);

    // The assets directory itself must be real, not a symlink to elsewhere.
    if (realRoot !== expectedRoot) return null;

    const realTarget = await realpath(target);
    if (sanitizeRelativePath(realRoot, path.relative(realRoot, realTarget)) === false) {
      return null;
    }
  }

  return target;
}
