import * as electron from "electron";

import type {
  PluginDesiredState,
  PluginRealmBootstrap,
  PluginRealmDesiredChange,
} from "@shared/contracts/plugin-manager-api";
import { serializeRuntimeState } from "@shared/plugin/runtime-state";
import { PreloadPluginLoader, type PreloadRequire } from "./loader";
import { createRegistry, type RegistryLoad } from "@shared/plugin/registry";
import { LOADED_REALM_IDS } from "virtual:open-orpheus/realm-runtime";

/** Plugin preload bundles may only require Electron. */
const preloadRequire: PreloadRequire = (id) => {
  if (id === "electron") return electron;
  throw new Error(`Plugin preloads may only require "electron" (got "${id}")`);
};

/**
 * Ask the main process for a revisioned bootstrap snapshot, evaluate the CJS
 * bundles in this preload context, and activate the enabled plugins.
 *
 * Evaluation happens in the preload realm rather than the renderer: the
 * sandboxed preload can evaluate a bundle with a restricted `require` (only
 * `electron`), while the renderer cannot.
 */
export async function installPreloadPlugins(load: RegistryLoad, realm: string): Promise<void> {
  if (!LOADED_REALM_IDS.includes(realm)) {
    throw new Error(`Unknown plugin realm "${realm}"`);
  }

  const latest = new Map<string, PluginDesiredState>();
  const current = new PreloadPluginLoader({
    sources: new Map(),
    registry: createRegistry(load),
    requireModule: preloadRequire,
    onStatus: (id, snapshot) => {
      electron.ipcRenderer.send("plugins.realmReport", {
        realm,
        id,
        desiredRevision: snapshot.desired.revision,
        attempt: snapshot.attempt,
        state: serializeRuntimeState(snapshot.state),
      });
    },
  });

  window.addEventListener("unload", () => {
    void current.deactivateAll();
  });

  // Events that arrive while the initial snapshot is loading must be applied
  // after it, otherwise a disable racing the bootstrap could be lost.
  const pending: PluginRealmDesiredChange[] = [];
  let initializing = true;

  electron.ipcRenderer.on("plugins.realmRetry", (_event, payload: unknown) => {
    if (payload === null || typeof payload !== "object") return;
    const { realm: payloadRealm, id } = payload as { realm?: unknown; id?: unknown };
    if (payloadRealm !== realm || typeof id !== "string") return;
    current.retry(id);
  });

  electron.ipcRenderer.on("plugins.realmChanged", (_event, payload: unknown) => {
    const change = parseChange(payload, realm);
    if (!change) return;
    if (initializing) {
      pending.push(change);
      return;
    }
    void applyChange(current, realm, latest, change);
  });

  try {
    let bootstrap: PluginRealmBootstrap | null = null;
    try {
      bootstrap = (await electron.ipcRenderer.invoke(
        "plugins.realmBootstrap",
        realm
      )) as PluginRealmBootstrap | null;
    } catch (error) {
      LOGGER.error({ realm, err: error }, "Failed to load plugin realm bootstrap");
      return;
    }
    if (!bootstrap || !Array.isArray(bootstrap.plugins)) return;

    const sources = new Map<string, string>();
    for (const entry of bootstrap.plugins) {
      if (typeof entry.id !== "string") continue;
      // A missing source means the host could not read it. Keep the desired
      // state so the selection pass below fetches it and reports a real,
      // retryable load failure.
      if (typeof entry.source === "string") sources.set(entry.id, entry.source);
      latest.set(entry.id, entry.desired);
    }

    current.registerAll(sources);
  } finally {
    initializing = false;
    const folded = foldChanges(pending);
    pending.length = 0;

    for (const [id, change] of folded) {
      const previous = latest.get(id);
      if (!previous || change.revision >= previous.revision) {
        latest.set(id, { enabled: change.enabled, revision: change.revision });
      }
    }

    // Publish every pending enable before any plugin can start depending on
    // another one. Waiting for one activation here can deadlock the batch:
    // the dependency's desired state has not been applied yet, so it still
    // rejects as "not enabled" or "unknown".
    for (const [id, desired] of latest) {
      if (!desired.enabled || current.has(id)) continue;
      current.start(id, () => fetchRealmSource(id, realm), desired);
    }

    for (const [id, desired] of latest) {
      if (current.has(id)) current.applyDesiredState(id, desired);
    }

    // Disabled plugins that were registered still need cleanup and removal.
    const removals: Promise<void>[] = [];
    for (const [id, desired] of latest) {
      if (!desired.enabled && current.has(id)) removals.push(current.remove(id, desired));
    }
    await Promise.all(removals);
  }

  await current.waitForAll();
}

async function applyChange(
  current: PreloadPluginLoader,
  realm: string,
  latest: Map<string, PluginDesiredState>,
  change: PluginRealmDesiredChange
): Promise<void> {
  const previous = latest.get(change.id);
  if (previous && change.revision < previous.revision) return;

  const desired: PluginDesiredState = { enabled: change.enabled, revision: change.revision };
  latest.set(change.id, desired);

  if (!change.enabled) {
    await current.remove(change.id, desired);
    return;
  }

  if (current.has(change.id)) {
    current.applyDesiredState(change.id, desired);
    return;
  }

  await current.enable(change.id, () => fetchRealmSource(change.id, realm), desired);
}

function parseChange(payload: unknown, realm: string): PluginRealmDesiredChange | null {
  if (payload === null || typeof payload !== "object") return null;
  const {
    realm: payloadRealm,
    id,
    enabled,
    revision,
  } = payload as {
    realm?: unknown;
    id?: unknown;
    enabled?: unknown;
    revision?: unknown;
  };
  if (payloadRealm !== realm || typeof id !== "string") return null;
  if (typeof enabled !== "boolean" || typeof revision !== "number") return null;
  return { realm, id, enabled, revision };
}

function foldChanges(
  changes: readonly PluginRealmDesiredChange[]
): Map<string, PluginRealmDesiredChange> {
  const folded = new Map<string, PluginRealmDesiredChange>();
  for (const change of changes) {
    const previous = folded.get(change.id);
    if (!previous || change.revision >= previous.revision) folded.set(change.id, change);
  }
  return folded;
}

async function fetchRealmSource(id: string, realm: string): Promise<string | null> {
  const source = await electron.ipcRenderer
    .invoke("plugins.realmSource", realm, id)
    .catch((error: unknown) => {
      LOGGER.error({ pluginId: id, realm, err: error }, "Failed to fetch plugin realm source");
      return null;
    });
  return typeof source === "string" ? source : null;
}
