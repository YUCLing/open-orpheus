import type { PluginRegistry, Registry } from "@shared/plugin/registry";

/** Everything a plugin's preload-realm module is handed. */
export interface PreloadPluginRuntime {
  /** The generated interface registry for the preload realm. */
  registry: Registry;
  /** The preload realm's plugin-contributed exports, keyed by plugin id. */
  plugins: PluginRegistry;
}

/**
 * The named exports a plugin's preload entry must provide.
 *
 * Preload entries are evaluated as CJS bundles; the plugin exposes the same
 * `activate`/`deactivate` lifecycle as the main realm.
 */
export interface PreloadPluginModule {
  activate(runtime: PreloadPluginRuntime): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
