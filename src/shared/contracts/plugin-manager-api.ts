/** @internal */
export enum PluginKind {
  Builtin = "builtin",
  User = "user",
}

/** Plugin identity layer. Built-ins take precedence over user plugins. */
/** @internal */
export enum PluginLayer {
  Builtin = "builtin",
  User = "user",
}

/** @internal */
export enum PluginRuntimeStateKind {
  Stopped = "stopped",
  Starting = "starting",
  Running = "running",
  Stopping = "stopping",
  Failed = "failed",
  Hung = "hung",
  Abandoned = "abandoned",
  Disposed = "disposed",
}

/** @internal */
export enum PluginFailureStage {
  Load = "load",
  Activate = "activate",
  Deactivate = "deactivate",
}

/** Serializable form of a runtime state, safe to cross IPC. */
/** @internal */
export interface SerializablePluginRuntimeState {
  kind: PluginRuntimeStateKind;
  desiredRevision: number;
  attempt?: number;
  stage?: PluginFailureStage;
  error?: string;
  retryable?: boolean;
  since?: number;
  startedAt?: number;
  timedOut?: boolean;
}

/** @internal */
export interface PluginDesiredState {
  enabled: boolean;
  revision: number;
}

/** @internal */
export enum PluginAvailabilityKind {
  Available = "available",
  Conflict = "conflict",
  Invalid = "invalid",
}

/** @internal */
export type PluginAvailability =
  | { kind: PluginAvailabilityKind.Available }
  | { kind: PluginAvailabilityKind.Conflict; paths: string[] }
  | { kind: PluginAvailabilityKind.Invalid; path: string; error: string };

/** @internal */
export enum PluginPresentationStatus {
  Unavailable = "unavailable",
  Disabled = "disabled",
  Starting = "starting",
  Running = "running",
  Degraded = "degraded",
  Failed = "failed",
  Stopping = "stopping",
  CleanupFailed = "cleanup-failed",
}

/** @internal */
export interface PluginRealmInstanceSummary {
  webContentsId: number;
  state: SerializablePluginRuntimeState;
}

/** @internal */
export interface PluginRealmSummary {
  declared: boolean;
  hostCount: number;
  instances: PluginRealmInstanceSummary[];
  counts: Partial<Record<PluginRuntimeStateKind, number>>;
}

/** @internal */
export interface PluginShadowedSource {
  layer: PluginLayer;
  path: string;
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
  layer: PluginLayer;
  /** Persisted intent. */
  desired: PluginDesiredState;
  /** Convenience mirror of `desired.enabled`. */
  enabled: boolean;
  availability: PluginAvailability;
  /** User plugins ignored because a built-in owns the same id. */
  shadowed: PluginShadowedSource[];
  /** Main-realm runtime state. */
  main: SerializablePluginRuntimeState;
  /** Per-window secondary-realm instances, keyed by realm. */
  realms: Record<string, PluginRealmSummary>;
  /** Derived presentation category; raw state above remains authoritative. */
  presentation: PluginPresentationStatus;
  error?: string;
}

/** @internal */
export interface PluginManagerState {
  /** False when the plugin system itself is disabled. */
  available: boolean;
  plugins: PluginManagerEntry[];
}

/** Revisioned desired-state notification sent to realm windows. */
/** @internal */
export interface PluginRealmDesiredChange {
  realm: string;
  id: string;
  enabled: boolean;
  revision: number;
}

/** What a newly created realm window needs to start its plugins. */
/** @internal */
export interface PluginRealmBootstrap {
  realm: string;
  plugins: Array<{
    id: string;
    desired: PluginDesiredState;
    source: string;
  }>;
}

/** Per-plugin runtime report sent from a realm window. */
/** @internal */
export interface PluginRealmReport {
  realm: string;
  id: string;
  desiredRevision: number;
  attempt: number;
  state: SerializablePluginRuntimeState;
}

/** @internal */
export interface PluginManagerContract {
  platform: NodeJS.Platform;
  versions: NodeJS.ProcessVersions;

  list(): Promise<PluginManagerState>;
  setEnabled(id: string, enabled: boolean): Promise<PluginManagerState>;
  retry(id: string): Promise<PluginManagerState>;

  events: {
    /** Fired when a plugin's desired state or runtime state changes. */
    changed(callback: () => void): void;
  };
}
