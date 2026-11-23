/** Interfaces for the plugin host realm configuration in `realms.ts`. */

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

/** A type-only SDK entry that has no realm or runtime registry. */
export interface TypeOnlySdkConfig {
  /** Contract file, relative to the project root. */
  contract: string;
  /** Directory holding the emitted `src/**` declarations, relative to the SDK package. */
  host: string;
  /** Package entry point, relative to the SDK package. */
  index: string;
  /** Export lines for the package entry point. */
  indexExports: string[];
  /** Package subpath served by this SDK entry, e.g. "./configuration". */
  packageSubpath: string;
}
