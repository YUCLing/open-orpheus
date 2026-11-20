export type MountFn = (element: HTMLDivElement) => void | (() => void);

export interface ManagerUIPlugin {
  configuration?: {
    mount?: MountFn;
  };
}

export interface API extends EventTarget {
  /** @internal */
  plugins: Record<string, ManagerUIPlugin>;
  /**
   * Register this plugin's configuration contribution.
   *
   * Throws when `id` is already registered. Called from the plugin's
   * plugin-manager realm `activate()`.
   */
  register(id: string, plugin: ManagerUIPlugin): void;
  /**
   * Remove a registration. Idempotent.
   *
   * Plugin authors call this from `deactivate()`; the host does not
   * automatically unregister contributions on their behalf.
   */
  unregister(id: string): void;
}
