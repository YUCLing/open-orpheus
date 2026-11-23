/**
 * Single source of truth for plugin host realms.
 *
 * This file is the config. The interfaces live in `tools/registry/realms.types.ts`;
 * the derived ID lists stay here because they are computed from this literal.
 *
 * Build-time only. The same definition drives the virtual registry, the plugin
 * API SDK, the realm-runtime Vite module, and the realm-display module.
 * Nothing under `src/` imports this file; the Vite plugin projects the small
 * runtime subset.
 */
import type {
  RealmDefinition,
  RealmPluginEntry,
  TypeOnlySdkConfig,
} from "../registry/realms.types.ts";

/** Type-only entry points that are not realms. */
export const TYPE_ONLY_SDKS = {
  configuration: {
    contract: "src/shared/plugin/configuration/index.ts",
    host: "dist/configuration/host",
    index: "dist/configuration/index.d.ts",
    indexExports: [
      'export type { ConfigurationContext, ConfigurationModule, ConfigurationUnmount } from "./host/src/shared/plugin/configuration/index";',
    ],
    packageSubpath: "./configuration",
  },
} as const satisfies Record<string, TypeOnlySdkConfig>;

export const REALMS = {
  main: {
    virtualId: "virtual:open-orpheus/registry",
    displayName: "Main",
    scan: {
      entries: ["src/main.ts"],
      excludedPrefixes: ["main/plugin/", "preload/", "shared/plugin/runtime-state", "worklets/"],
      excludedFiles: ["main"],
      hardcoded: [],
    },
    pluginEntry: {
      metadataKey: "main",
      extension: ".mjs",
      required: true,
      reportStatus: false,
    },
    sdk: {
      contract: "src/shared/plugin/realms/main/index.ts",
      host: "dist/host",
      registryMap: "dist/registry-map.d.ts",
      index: "dist/index.d.ts",
      indexExports: [
        'export type { PluginModule, PluginRuntime } from "./host/src/shared/plugin/realms/main/index";',
        'export type { LoadedModule, PluginRegistry, Registry } from "./host/src/shared/plugin/registry";',
        'export type { RegistryLoad } from "./registry-map";',
      ],
      packageSubpath: ".",
    },
  },
  preload: {
    virtualId: "virtual:open-orpheus/registry/preload",
    displayName: "Preload",
    scan: {
      entries: ["src/preload.ts"],
      excludedPrefixes: ["main/", "preload/plugin/", "shared/plugin/runtime-state", "worklets/"],
      excludedFiles: ["preload"],
      hardcoded: [{ key: "@preload/logger", file: "preload/logger.ts" }],
    },
    pluginEntry: {
      metadataKey: "preload",
      extension: ".cjs",
      required: false,
      reportStatus: true,
    },
    sdk: {
      contract: "src/shared/plugin/realms/preload/index.ts",
      host: "dist/preload/host",
      registryMap: "dist/preload/registry-map.d.ts",
      index: "dist/preload/index.d.ts",
      indexExports: [
        'export type { PluginModule, PluginRuntime } from "./host/src/shared/plugin/realms/preload/index";',
        'export type { LoadedModule, PluginRegistry, Registry } from "./host/src/shared/plugin/registry";',
        'export type { RegistryLoad } from "./registry-map";',
      ],
      packageSubpath: "./preload",
    },
  },
  "plugin-manager": {
    virtualId: "virtual:open-orpheus/registry/plugin-manager",
    displayName: "Plugin Manager",
    scan: {
      entries: ["src/windows/plugin-manager.ts"],
      excludedPrefixes: ["main/", "preload/plugin/", "shared/plugin/runtime-state", "worklets/"],
      excludedFiles: ["windows/plugin-manager"],
      hardcoded: [
        { key: "@preload/logger", file: "preload/logger.ts" },
        { key: "@preload/util", file: "preload/util.ts" },
      ],
    },
    pluginEntry: {
      metadataKey: "plugin-manager",
      extension: ".cjs",
      required: false,
      reportStatus: true,
    },
    sdk: {
      contract: "src/shared/plugin/realms/plugin-manager/index.ts",
      host: "dist/plugin-manager/host",
      registryMap: "dist/plugin-manager/registry-map.d.ts",
      index: "dist/plugin-manager/index.d.ts",
      indexExports: [
        'export type { PluginModule, PluginRuntime } from "./host/src/shared/plugin/realms/plugin-manager/index";',
        'export type { LoadedModule, PluginRegistry, Registry } from "./host/src/shared/plugin/registry";',
        'export type { RegistryLoad } from "./registry-map";',
      ],
      packageSubpath: "./plugin-manager",
    },
  },
} as const satisfies Record<string, RealmDefinition>;

export type RealmId = keyof typeof REALMS;

export const REALM_IDS = Object.keys(REALMS) as RealmId[];

/** Realms that may be declared as plugin entry points in `metadata.json`. */
export type PluginRealmId = {
  [K in RealmId]: (typeof REALMS)[K] extends { pluginEntry: RealmPluginEntry } ? K : never;
}[RealmId];

export const PLUGIN_REALM_IDS = REALM_IDS.filter(
  (id): id is PluginRealmId => "pluginEntry" in REALMS[id]
);

/** Plugin realms whose windows report activation status. */
export type LoadedRealmId = {
  [K in PluginRealmId]: (typeof REALMS)[K] extends {
    pluginEntry: { reportStatus: true };
  }
    ? K
    : never;
}[PluginRealmId];

export const LOADED_REALM_IDS = PLUGIN_REALM_IDS.filter(
  (id): id is LoadedRealmId => REALMS[id].pluginEntry.reportStatus
);
