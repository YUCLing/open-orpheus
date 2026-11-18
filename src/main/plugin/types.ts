import type { PluginRegistry, Registry } from "@shared/plugin/registry";

/** Everything a plugin's main-realm module is handed. */
export type PluginRuntime = {
  /** The generated interface registry for the main realm. */
  registry: Registry;
  /** The main realm's plugin-contributed exports, keyed by plugin id. */
  plugins: PluginRegistry;
};

/**
 * The named exports a plugin's main-realm entry must provide.
 *
 * Identity (id, name, version) lives in the plugin's `metadata.json`; the
 * module only implements the lifecycle.
 */
export interface PluginModule {
  activate(runtime: PluginRuntime): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
