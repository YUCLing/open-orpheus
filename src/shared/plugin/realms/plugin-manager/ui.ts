export type MountFn = (element: HTMLDivElement) => void | (() => void);

export interface ManagerUIPlugin {
  configuration?: {
    mount?: MountFn;
  };
}

export interface API extends EventTarget {
  /** @internal */
  plugins: Record<string, ManagerUIPlugin>;
  register(id: string, plugin: ManagerUIPlugin): void;
  unregister(id: string): void;
}
