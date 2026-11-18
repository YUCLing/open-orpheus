import type { PluginRegistry, Registry } from "@shared/plugin/registry";

/** Everything a plugin's plugin-manager-realm module is handed. */
export interface PluginRuntime {
  /** The generated interface registry for the plugin-manager realm. */
  registry: Registry;
  /** The plugin-manager realm's plugin-contributed exports, keyed by plugin id. */
  plugins: PluginRegistry;
}

/**
 * The named exports a plugin's plugin-manager entry must provide.
 *
 * Entries are evaluated as CJS preload bundles and run inside the plugin
 * manager window's preload context.
 */
export interface PluginModule {
  activate(runtime: PluginRuntime): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

export type { API, ManagerUIPlugin, MountFn } from "./ui";
