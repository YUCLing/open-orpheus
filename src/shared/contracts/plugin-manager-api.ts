/** @internal */
export enum PluginKind {
  Builtin = "builtin",
  User = "user",
}

/** @internal */
export enum PluginActivationStatus {
  Active = "active",
  Inactive = "inactive",
  Partial = "partial",
  Failed = "failed",
}

/** @internal */
export enum PluginPreloadStatus {
  Pending = "pending",
  Active = "active",
  Inactive = "inactive",
  Failed = "failed",
}

/** @internal */
export interface RealmRuntimeStatus {
  status: PluginPreloadStatus;
  error?: string;
}

/** @internal */
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

/** @internal */
export interface PluginManagerState {
  /** False when the plugin system itself is disabled. */
  available: boolean;
  plugins: PluginManagerEntry[];
}

/** @internal */
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
