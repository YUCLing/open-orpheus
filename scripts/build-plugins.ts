import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runBuildCommand } from "./utils/run.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = path.join(ROOT, "packages");
const OUTPUT_DIR = path.join(ROOT, "out", "builtin-plugins");

interface PackageManifest {
  openOrpheus?: {
    builtinPlugin?: boolean;
  };
}

interface BuiltinPlugin {
  dir: string;
  name: string;
}

/**
 * Discover built-in plugin packages by convention: a package under `packages/`
 * that marks itself with `openOrpheus.builtinPlugin` and ships a `metadata.json`
 * plus a `build` script producing `dist/main`.
 */
async function discoverBuiltinPlugins(): Promise<BuiltinPlugin[]> {
  const entries = await readdir(PACKAGES_DIR, { withFileTypes: true });
  const plugins: BuiltinPlugin[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(PACKAGES_DIR, entry.name);
    let manifest: PackageManifest;
    try {
      manifest = JSON.parse(
        await readFile(path.join(dir, "package.json"), "utf8")
      ) as PackageManifest;
    } catch {
      continue;
    }
    if (manifest.openOrpheus?.builtinPlugin !== true) continue;
    plugins.push({
      dir,
      name: entry.name.replace(/^plugin-/, ""),
    });
  }

  return plugins;
}

const plugins = await discoverBuiltinPlugins();
await rm(OUTPUT_DIR, { recursive: true, force: true });

for (const plugin of plugins) {
  const result = await runBuildCommand(plugin.dir, "build");
  if (result.status !== 0) {
    console.error(`Failed to build built-in plugin: ${plugin.name}`);
    process.exit(1);
  }

  const target = path.join(OUTPUT_DIR, plugin.name);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(plugin.dir, "dist"), target, { recursive: true });
}

console.log(`Built ${plugins.length} built-in plugin(s) into ${path.relative(ROOT, OUTPUT_DIR)}`);
