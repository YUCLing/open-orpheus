/** @internal */
export enum PluginConfigurationStateKind {
  Unloaded = "unloaded",
  WaitingForPreload = "waiting-for-preload",
  Loading = "loading",
  Ready = "ready",
  Mounting = "mounting",
  Mounted = "mounted",
  Unmounting = "unmounting",
  Failed = "failed",
}

/** @internal */
export enum PluginConfigurationFailureStage {
  Preload = "preload",
  Import = "import",
  Validate = "validate",
  Mount = "mount",
  Unmount = "unmount",
}

/** Renderer-local state of one plugin's configuration UI. */
/** @internal */
export interface PluginConfigurationState {
  kind: PluginConfigurationStateKind;
  desiredRevision: number;
  attempt: number;
  stage?: PluginConfigurationFailureStage;
  error?: string;
  retryable?: boolean;
}

/** Outcome of waiting for the plugin-manager preload realm of one plugin. */
/** @internal */
export type PluginRealmActivationOutcome =
  | { kind: "running" }
  | { kind: "failed"; error?: string }
  | { kind: "missing" };

/** Renderer side of the strict cleanup ordering with the plugin-manager preload. */
/** @internal */
export interface PluginConfigurationHost {
  dispose(pluginId: string, revision: number): void | Promise<void>;
}

/** Host-only API the plugin-manager preload exposes to its renderer. */
/** @internal */
export interface PluginManagerHostBridge {
  setConfigurationHost(host: PluginConfigurationHost): void;
  waitForRealm(pluginId: string): Promise<PluginRealmActivationOutcome>;
}
