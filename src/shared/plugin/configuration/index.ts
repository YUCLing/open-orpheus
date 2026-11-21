/** Everything a plugin's configuration module is handed when it mounts. */
export interface ConfigurationContext {
  readonly pluginId: string;
  /** `assets://` base URL for this plugin's assets, for resolving relative resources. */
  readonly assetsBaseUrl: string;
  /** Aborted when the host closes or invalidates this mount. */
  readonly signal: AbortSignal;
}

/** Cleanup returned by `mount()`, if the plugin needs one. */
export type ConfigurationUnmount = () => void | Promise<void>;

/**
 * The named exports a plugin's configuration entry must provide.
 *
 * Entries are browser ESM modules served from the plugin's `assets/`
 * directory. The host imports, mounts, and unmounts them. Module top-level
 * code must only define exports: ESM evaluation cannot be undone when the host
 * invalidates an attempt, so lifecycle work belongs in `mount()`.
 */
export interface ConfigurationModule {
  mount(
    root: HTMLDivElement,
    context: ConfigurationContext
  ): void | ConfigurationUnmount | Promise<void | ConfigurationUnmount>;
}
