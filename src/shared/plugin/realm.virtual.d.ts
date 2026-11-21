declare module "virtual:open-orpheus/realm-runtime" {
  export interface RealmRuntimeEntry {
    pluginEntry?: {
      metadataKey: string;
      extension: ".mjs" | ".cjs";
      required: boolean;
      reportStatus: boolean;
    };
  }

  export const REALM_RUNTIME: Readonly<Record<string, RealmRuntimeEntry>>;
  export const REALM_IDS: readonly string[];
  export const PLUGIN_REALM_IDS: readonly string[];
  export const LOADED_REALM_IDS: readonly string[];
}

declare module "virtual:open-orpheus/realm-display" {
  export const REALM_DISPLAY_NAMES: Readonly<Record<string, string>>;
}
