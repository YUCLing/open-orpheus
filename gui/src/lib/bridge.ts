/**
 * Retrieve a typed IPC bridge exposed by the preload.
 *
 * The preload exposes a plain object with sync scalars directly on it,
 * plus `_call(channelSuffix, ...args)` and `_on(eventSuffix, callback)`
 * primitives.  This function wraps those in a Proxy that builds channel
 * paths from property access, giving full autocomplete.
 *
 * Usage:
 *   import type { ManageContract } from "$bridge/contracts/manage-api";
 *   const api = getBridge<ManageContract>("manage");
 *   api.cache.getStats();           // → _call("cache.getStats")
 *   api.events.lyricsUpdate(cb);    // → _on("lyricsUpdate", cb)
 *   api.platform;                   // sync scalar, returned directly
 */

interface BridgeRaw {
  _call(channel: string, ...args: unknown[]): Promise<unknown>;
  _on(event: string, callback: (...args: unknown[]) => void): void;
  [key: string]: unknown;
}

export function getBridge<T>(name: string): T {
  const raw = (window as unknown as Record<string, unknown>)[name] as BridgeRaw | undefined;
  if (!raw) {
    throw new Error(`Bridge "${name}" is not exposed by the preload for this window.`);
  }

  return new Proxy(raw, {
    get(_target, prop: string | symbol) {
      if (typeof prop === "symbol") return undefined;
      if (prop in raw) return raw[prop];
      return buildPathProxy([String(prop)], raw);
    },
  }) as T;
}

function noop() {}

function buildPathProxy(path: string[], raw: BridgeRaw): unknown {
  return new Proxy(noop, {
    apply(_target: unknown, _thisArg: unknown, args: unknown[]) {
      if (path[0] === "events") {
        const eventName = path.slice(1).join(".");
        return raw._on(eventName, args[0] as (...a: unknown[]) => void);
      }
      const channel = path.join(".");
      return raw._call(channel, ...args);
    },
    get(_target: unknown, prop: string | symbol) {
      if (prop === "then" || prop === "catch" || typeof prop === "symbol") return undefined;
      return buildPathProxy([...path, String(prop)], raw);
    },
  });
}
