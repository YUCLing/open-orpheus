import type { Plugin } from "vite";

import { LOADED_REALM_IDS, PLUGIN_REALM_IDS, REALMS, REALM_IDS } from "../../config/realms.js";

const RUNTIME_ID = "virtual:open-orpheus/realm-runtime";
const DISPLAY_ID = "virtual:open-orpheus/realm-display";

/**
 * Inject the small runtime subset of the realm manifest.
 *
 * The full manifest remains build-time only. Main/preload modules import the
 * runtime module; the GUI imports only the display module.
 */
export default function RealmRuntimePlugin(): Plugin {
  let runtime: string | null = null;
  let display: string | null = null;

  return {
    name: "open-orpheus-realms",

    resolveId(id) {
      return id === RUNTIME_ID || id === DISPLAY_ID ? id : null;
    },

    load(id) {
      if (id === RUNTIME_ID) {
        runtime ??= renderRuntime();
        return runtime;
      }
      if (id === DISPLAY_ID) {
        display ??= renderDisplay();
        return display;
      }
      return null;
    },
  };
}

function renderRuntime(): string {
  const runtime = Object.fromEntries(
    REALM_IDS.map((realm) => [realm, { pluginEntry: REALMS[realm].pluginEntry ?? null }])
  );
  return [
    "// GENERATED at build time by tools/forge/plugins/RealmRuntimePlugin.ts.",
    `export const REALM_RUNTIME = ${JSON.stringify(runtime)};`,
    `export const REALM_IDS = ${JSON.stringify(REALM_IDS)};`,
    `export const PLUGIN_REALM_IDS = ${JSON.stringify(PLUGIN_REALM_IDS)};`,
    `export const LOADED_REALM_IDS = ${JSON.stringify(LOADED_REALM_IDS)};`,
    "",
  ].join("\n");
}

function renderDisplay(): string {
  const display = Object.fromEntries(REALM_IDS.map((realm) => [realm, REALMS[realm].displayName]));
  return [
    "// GENERATED at build time by tools/forge/plugins/RealmRuntimePlugin.ts.",
    `export const REALM_DISPLAY_NAMES = ${JSON.stringify(display)};`,
    "",
  ].join("\n");
}
