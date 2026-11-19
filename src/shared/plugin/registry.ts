/**
 * Loose shape of a build-time registry.
 *
 * The host only passes the registry through to plugins; precise per-module
 * types live in the generated `@open-orpheus/plugin-api` package.
 */
export type RegistryLoad = Record<string, () => Promise<unknown>>;

/**
 * The resolved value type for a registry key.
 *
 * `LoadedModule<"@main/logger">` is equivalent to
 * `Awaited<ReturnType<RegistryLoad["@main/logger"]>>`.
 */
export type LoadedModule<Key extends keyof RegistryLoad> = Awaited<ReturnType<RegistryLoad[Key]>>;

/**
 * Lazy access to a realm's host module surface.
 *
 * Every module is imported on demand; the registry itself has no static
 * imports and therefore no initialization side effects.
 */
type RegistryLoader = (...args: never[]) => unknown;

export type Registry<Load extends RegistryLoad = RegistryLoad> = {
  /** Import a module. Resolves immediately for modules that are already evaluated. */
  load<Key extends keyof Load>(key: Key): ReturnType<Extract<Load[Key], RegistryLoader>>;
  /** Every key this registry can serve. */
  keys(): Array<keyof Load>;
};

/** @internal */
export function createRegistry<Load extends RegistryLoad>(lazyModules: Load): Registry<Load> {
  return {
    load<Key extends keyof Load>(key: Key): ReturnType<Extract<Load[Key], RegistryLoader>> {
      return lazyModules[key]() as ReturnType<Extract<Load[Key], RegistryLoader>>;
    },
    keys(): Array<keyof Load> {
      return Object.keys(lazyModules) as Array<keyof Load>;
    },
  };
}

/**
 * Plugin-contributed exports for one realm, keyed by plugin id.
 *
 * `load` evaluates the plugin module and returns its exports without waiting
 * for activation. `whenActive` waits for the plugin's current activation
 * attempt to be running, and reports readiness cycles instead of deadlocking.
 */
export interface PluginRegistry {
  load<T = unknown>(id: string): Promise<T>;
  whenActive<T = unknown>(id: string): Promise<T>;
  keys(): string[];
}

/** @internal */
export interface PluginRegistrySource {
  load(): Promise<unknown>;
  whenActive(): Promise<unknown>;
}

/** @internal */
export interface MutablePluginRegistry extends PluginRegistry {
  /** Forget the cached evaluation for a plugin that has been removed. */
  forget(id: string): void;
  /** Bind a registry to the plugin currently activating. */
  forPlugin(id: string): PluginRegistry;
}

/** @internal */
export class PluginReadinessCycleError extends Error {
  constructor(readonly chain: string[]) {
    super(`Activation readiness cycle: ${chain.join(" -> ")}`);
    this.name = "PluginReadinessCycleError";
  }
}

/** @internal */
export interface MutablePluginRegistryOptions {
  /** Called when a readiness wait is registered, so the caller can report it. */
  onWait?: (owner: string, target: string) => void;
}

/** @internal */
export function createPluginRegistry(
  sources: ReadonlyMap<string, PluginRegistrySource>,
  options: MutablePluginRegistryOptions = {}
): MutablePluginRegistry {
  const cache = new Map<string, Promise<unknown>>();
  const readiness = new Map<string, Promise<unknown>>();
  const edges = new Map<string, Set<string>>();

  function forget(id: string): void {
    cache.delete(id);
    readiness.delete(id);
    edges.delete(id);
    for (const targets of edges.values()) targets.delete(id);
  }

  function addEdge(owner: string, target: string): void {
    let targets = edges.get(owner);
    if (!targets) {
      targets = new Set();
      edges.set(owner, targets);
    }
    targets.add(target);
    options.onWait?.(owner, target);
  }

  function findCycle(owner: string, target: string): string[] | null {
    const stack: string[] = [];
    const visiting = new Set<string>();

    const visit = (node: string): string[] | null => {
      if (node === owner) return [...stack, owner];
      if (visiting.has(node)) return null;
      visiting.add(node);
      stack.push(node);
      for (const next of edges.get(node) ?? []) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
      stack.pop();
      return null;
    };

    return visit(target);
  }

  function sourceFor(id: string): PluginRegistrySource | undefined {
    return sources.get(id);
  }

  function loadShared(id: string): Promise<unknown> {
    const cached = cache.get(id);
    if (cached) return cached;
    const source = sourceFor(id);
    if (!source) return Promise.reject(new Error(`Unknown plugin "${id}"`));
    const pending = source.load();
    cache.set(id, pending);
    void pending.catch(() => {
      if (cache.get(id) === pending) cache.delete(id);
    });
    return pending;
  }

  function whenActiveShared(owner: string | null, id: string): Promise<unknown> {
    if (owner === id) {
      return Promise.reject(new PluginReadinessCycleError([owner, owner]));
    }
    if (owner) {
      const cycle = findCycle(owner, id);
      if (cycle) return Promise.reject(new PluginReadinessCycleError([owner, ...cycle]));
      addEdge(owner, id);
    }

    const cached = readiness.get(id);
    if (cached) return cached;
    const source = sourceFor(id);
    if (!source) return Promise.reject(new Error(`Unknown plugin "${id}"`));
    const pending = source.whenActive();
    readiness.set(id, pending);
    void pending.catch(() => {
      if (readiness.get(id) === pending) readiness.delete(id);
    });
    return pending;
  }

  const shared: MutablePluginRegistry = {
    load<T = unknown>(id: string): Promise<T> {
      return loadShared(id) as Promise<T>;
    },
    whenActive<T = unknown>(id: string): Promise<T> {
      return whenActiveShared(null, id) as Promise<T>;
    },
    keys(): string[] {
      return [...sources.keys()];
    },
    forget,
    forPlugin(owner: string): PluginRegistry {
      return {
        load<T = unknown>(id: string): Promise<T> {
          return loadShared(id) as Promise<T>;
        },
        whenActive<T = unknown>(id: string): Promise<T> {
          return whenActiveShared(owner, id) as Promise<T>;
        },
        keys(): string[] {
          return [...sources.keys()];
        },
      };
    },
  };

  return shared;
}
