import type { Plugin } from "vite";

import { collectRegistryEntries, type RegistryEntry } from "../scripts/registry-scan.js";
import { REALMS, REALM_IDS, type RealmId } from "../scripts/realms.js";

const VIRTUAL_TO_REALM = new Map<string, RealmId>(
  REALM_IDS.map((realm) => [REALMS[realm].virtualId, realm])
);

/**
 * Build-time registry module.
 *
 * Every realm imports its own virtual module; a single plugin instance handles
 * all of them, resolving each ID to a lazy `load` map generated from that
 * realm's real module graph. Nothing is written to disk, and the plugin-facing
 * type surface is generated separately by `packages/plugin-api`.
 */
export default function RegistryPlugin(): Plugin {
  const generated = new Map<RealmId, string>();

  return {
    name: "open-orpheus-registry",

    resolveId(id) {
      return VIRTUAL_TO_REALM.has(id) ? id : null;
    },

    load(id) {
      const realm = VIRTUAL_TO_REALM.get(id);
      if (!realm) return null;
      let rendered = generated.get(realm);
      if (!rendered) {
        rendered = renderRegistry(collectRegistryEntries({ root: process.cwd(), realm }), realm);
        generated.set(realm, rendered);
      }
      return rendered;
    },
  };
}

function renderRegistry(entries: RegistryEntry[], realm: RealmId): string {
  const lines: string[] = [];
  lines.push("// GENERATED at build time by plugins/RegistryPlugin.ts.");
  lines.push(`export const realm = ${JSON.stringify(realm)};`);
  lines.push("export const load = {");
  for (const entry of entries) {
    lines.push(`  ${JSON.stringify(entry.key)}: () => import(${JSON.stringify(entry.key)}),`);
  }
  lines.push("};");
  lines.push("");
  return lines.join("\n");
}
