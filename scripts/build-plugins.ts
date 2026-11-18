import { access, cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runBuildCommand } from "./utils/run.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = path.join(ROOT, "packages");
const OUTPUT_DIR = path.join(ROOT, "out", "builtin-plugins");

interface BuiltinPlugin {
  dir: string;
  name: string;
}

/**
 * Discover built-in plugin packages by path convention: every directory under
 * `packages/` named `plugin-builtin-*` is a built-in plugin.
 */
async function discoverBuiltinPlugins(): Promise<BuiltinPlugin[]> {
  const entries = await readdir(PACKAGES_DIR, { withFileTypes: true });
  const plugins: BuiltinPlugin[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith("plugin-builtin-")) continue;

    const dir = path.join(PACKAGES_DIR, entry.name);
    const required = ["package.json", "metadata.json"];
    const missing: string[] = [];
    for (const file of required) {
      try {
        await access(path.join(dir, file));
      } catch {
        missing.push(file);
      }
    }
    if (missing.length > 0) {
      console.error(`Built-in plugin ${entry.name} is missing ${missing.join(", ")}`);
      process.exit(1);
    }

    plugins.push({
      dir,
      name: entry.name.slice("plugin-builtin-".length),
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
