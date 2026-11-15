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

export interface RealmRuntimeStatus {
  status: PluginPreloadStatus;
  error?: string;
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
  /**
   * Secondary-realm outcomes, keyed by realm. Realms with `reportStatus` in the
   * central manifest are included; realms without a plugin entry are omitted.
   */
  realmStatus?: Partial<Record<string, RealmRuntimeStatus>>;
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
