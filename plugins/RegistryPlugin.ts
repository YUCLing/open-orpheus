import type { Plugin } from "vite";

import {
  collectRegistryEntries,
  type RealmId,
  type RegistryEntry,
} from "../scripts/registry-scan.js";

const VIRTUAL_IDS: Record<RealmId, string> = {
  main: "virtual:open-orpheus/registry",
  preload: "virtual:open-orpheus/registry/preload",
};

export interface RegistryPluginOptions {
  /** Realm to generate. Defaults to `main`. */
  realm?: RealmId;
}

/**
 * Build-time registry module.
 *
 * Each realm imports its own virtual module; this plugin resolves it to a lazy
 * `load` map generated from that realm's real module graph. Nothing is written
 * to disk, and the type surface for plugin authors is generated separately by
 * `packages/plugin-api`.
 */
export default function RegistryPlugin(options: RegistryPluginOptions = {}): Plugin {
  const realm = options.realm ?? "main";
  const virtualId = VIRTUAL_IDS[realm];
  let generated: string | null = null;

  return {
    name: `open-orpheus-registry-${realm}`,

    resolveId(id) {
      return id === virtualId ? virtualId : null;
    },

    load(id) {
      if (id !== virtualId) return null;
      generated ??= renderRegistry(collectRegistryEntries({ root: process.cwd(), realm }));
      return generated;
    },
  };
}

function renderRegistry(entries: RegistryEntry[]): string {
  const lines: string[] = [];
  lines.push("// GENERATED at build time by plugins/RegistryPlugin.ts.");
  lines.push("export const load = {");
  for (const entry of entries) {
    lines.push(`  ${JSON.stringify(entry.key)}: () => import(${JSON.stringify(entry.key)}),`);
  }
  lines.push("};");
  lines.push("");
  return lines.join("\n");
}
