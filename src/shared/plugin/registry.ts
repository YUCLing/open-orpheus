/**
 * Loose shape of a build-time registry.
 *
 * The host only passes the registry through to plugins; precise per-module
 * types live in the generated `@open-orpheus/plugin-api` package.
 */
export type RegistryLoad = Record<string, () => Promise<unknown>>;

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
 * The entry module is the plugin's public surface; lifecycle exports
 * (`activate`/`deactivate`) are reserved and typed away in the SDK.
 */
export interface PluginRegistry {
  load<T = unknown>(id: string): Promise<T>;
  keys(): string[];
}

export interface MutablePluginRegistry extends PluginRegistry {
  /** Forget the cached evaluation for a plugin that has been removed. */
  forget(id: string): void;
}

export function createPluginRegistry(
  loaders: ReadonlyMap<string, () => Promise<unknown>>
): MutablePluginRegistry {
  const cache = new Map<string, Promise<unknown>>();

  return {
    load<T = unknown>(id: string): Promise<T> {
      const cached = cache.get(id);
      if (cached) return cached as Promise<T>;
      const loader = loaders.get(id);
      if (!loader) {
        return Promise.reject(new Error(`Unknown plugin "${id}"`));
      }
      const pending = loader();
      cache.set(id, pending);
      void pending.catch(() => {
        if (cache.get(id) === pending) cache.delete(id);
      });
      return pending as Promise<T>;
    },
    keys(): string[] {
      return [...loaders.keys()];
    },
    forget(id: string): void {
      cache.delete(id);
    },
  };
}
