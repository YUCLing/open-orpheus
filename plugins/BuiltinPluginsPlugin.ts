import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Plugin } from "vite";

import { runBuildCommand } from "../scripts/utils/run.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Builds the built-in plugin packages before Vite starts bundling.
 *
 * Running here covers dev startup, Forge packaging, and every source-build
 * channel that uses this Vite config.
 */
export default function BuiltinPluginsPlugin(): Plugin {
  let built = false;
  return {
    name: "open-orpheus-builtin-plugins",
    async buildStart() {
      if (built) return;
      built = true;
      const { status } = await runBuildCommand(ROOT, "build:plugins");
      if (status !== 0) {
        throw new Error(`build:plugins failed with status ${status ?? "unknown"}`);
      }
    },
  };
}
