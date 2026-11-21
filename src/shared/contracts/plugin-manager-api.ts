export enum PluginKind {
  Builtin = "builtin",
  User = "user",
}

export enum PluginActivationStatus {
  Active = "active",
  Inactive = "inactive",
  Partial = "partial",
  Failed = "failed",
}

export enum PluginPreloadStatus {
  Pending = "pending",
  Active = "active",
  Inactive = "inactive",
  Failed = "failed",
}

export interface PluginManagerEntry {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  /** Resolved `assets://plugins/<id>/<path>` URL, when the plugin declares an icon. */
  icon?: string;
  kind: PluginKind;
  /** Persisted intent: should this plugin be activated? */
  enabled: boolean;
  /** Runtime outcome from the plugin loader. */
  status: PluginActivationStatus;
  error?: string;
  /** Preload-realm outcome reported by the window that evaluated it. */
  preloadStatus?: PluginPreloadStatus;
  preloadError?: string;
}

export interface PluginManagerState {
  /** False when the plugin system itself is disabled. */
  available: boolean;
  plugins: PluginManagerEntry[];
}

export interface PluginManagerContract {
  platform: NodeJS.Platform;
  versions: NodeJS.ProcessVersions;

  list(): Promise<PluginManagerState>;
  setEnabled(id: string, enabled: boolean): Promise<PluginManagerState>;

  events: {
    /** Fired when a plugin's runtime or preload status changes. */
    changed(callback: () => void): void;
  };
}
