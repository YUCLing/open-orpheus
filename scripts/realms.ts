/**
 * Single source of truth for plugin host realms.
 *
 * Build-time only. The same definition drives the virtual registry, the
 * plugin API SDK, the realm-runtime Vite module, and the realm-display module.
 * Nothing under `src/` imports this file; the Vite plugin projects the small
 * runtime subset.
 */

export interface HardcodedRegistryEntry {
  /** Public registry key, independent of the alias that would derive it. */
  key: string;
  /** Source file, relative to `src/`. */
  file: string;
}

export interface RealmScanConfig {
  /** Entry files relative to the project root. */
  entries: string[];
  /** Prefixes (relative to `src/`) to exclude from the surface. */
  excludedPrefixes: string[];
  /** Paths without extension (relative to `src/`) that are the entry itself. */
  excludedFiles: string[];
  /** Modules that are public surface without an import edge from the entry. */
  hardcoded: HardcodedRegistryEntry[];
}

export interface RealmSdkConfig {
  /** Contract file, relative to the project root. */
  contract: string;
  /** Directory holding the generated `src/**` declarations, relative to the SDK package. */
  host: string;
  /** Precise `RegistryLoad` map file, relative to the SDK package. */
  registryMap: string;
  /** Package entry point, relative to the SDK package. */
  index: string;
  /** Export lines for the package entry point. */
  indexExports: string[];
  /** Package subpath served by this SDK entry, e.g. "." or "./preload". */
  packageSubpath: string;
}

export interface RealmPluginEntry {
  /** Key used in `metadata.json` under `realms`. */
  metadataKey: string;
  extension: ".mjs" | ".cjs";
  required: boolean;
  /** Whether windows of this realm report activation status to the main process. */
  reportStatus: boolean;
}

export interface RealmDefinition {
  /** Build-time virtual module ID imported by the realm's preload/main entry. */
  virtualId: string;
  /** Human-readable label used by the plugin manager UI. */
  displayName: string;
  scan: RealmScanConfig;
  pluginEntry?: RealmPluginEntry;
  sdk?: RealmSdkConfig;
}

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
        'export type { API, ManagerUIPlugin, MountFn } from "./host/src/shared/plugin/realms/plugin-manager/ui";',
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
