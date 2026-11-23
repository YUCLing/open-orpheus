import type { Plugin } from "vite";

import { runBuildCommand } from "../../shared/process.js";
import { PROJECT_ROOT } from "../../shared/paths.js";

const ROOT = PROJECT_ROOT;

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
