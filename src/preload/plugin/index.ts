import * as electron from "electron";

import { PreloadPluginLoader, type PreloadRequire } from "./loader";
import { createRegistry, type RegistryLoad } from "@shared/plugin/registry";
import { LOADED_REALM_IDS } from "virtual:open-orpheus/realm-runtime";

/** Plugin preload bundles may only require Electron. */
const preloadRequire: PreloadRequire = (id) => {
  if (id === "electron") return electron;
  throw new Error(`Plugin preloads may only require "electron" (got "${id}")`);
};

/**
 * Ask the main process for the discovered preload plugins, evaluate their CJS
 * bundles in this preload context, and activate them.
 *
 * Evaluation happens in the preload realm rather than the renderer: the
 * sandboxed preload can evaluate a bundle with a restricted `require` (only
 * `electron`), while the renderer cannot.
 */
export async function installPreloadPlugins(load: RegistryLoad, realm: string): Promise<void> {
  if (!LOADED_REALM_IDS.includes(realm)) {
    throw new Error(`Unknown plugin realm "${realm}"`);
  }

  const current = new PreloadPluginLoader({
    sources: new Map(),
    registry: createRegistry(load),
    requireModule: preloadRequire,
    onStatus: (id, status, error) => {
      electron.ipcRenderer.send("plugins.realmStatus", { realm, id, status, error });
    },
  });

  window.addEventListener("unload", () => {
    void current.deactivateAll();
  });

  // Events that arrive while the initial list is loading must be applied after
  // it, otherwise a disable racing the initial load could be lost.
  const pending: unknown[] = [];
  let initializing = true;

  electron.ipcRenderer.on("plugins.realmChanged", (_event, payload: unknown) => {
    if (
      payload === null ||
      typeof payload !== "object" ||
      (payload as { realm?: unknown }).realm !== realm
    ) {
      return;
    }
    if (initializing) {
      pending.push(payload);
      return;
    }
    void applyPreloadChange(current, realm, payload);
  });

  try {
    let ids: unknown;
    try {
      ids = await electron.ipcRenderer.invoke("plugins.realm", realm);
    } catch (error) {
      LOGGER.error({ err: error }, "Failed to list preload plugins");
      return;
    }
    if (!Array.isArray(ids)) return;

    const sources = new Map<string, string>();
    for (const id of ids) {
      if (typeof id !== "string") continue;
      const source = await fetchRealmSource(id, realm);
      if (source !== null) sources.set(id, source);
    }
    current.registerAll(sources);
    current.enableAll();
  } finally {
    initializing = false;
    for (const payload of pending) void applyPreloadChange(current, realm, payload);
  }

  // Start from the already-enabled set, but do not keep change notifications
  // queued until every plugin finishes activating.
  await current.waitForAll();
}

async function applyPreloadChange(
  current: PreloadPluginLoader,
  realm: string,
  payload: unknown
): Promise<void> {
  if (payload === null || typeof payload !== "object") return;
  const { id, enabled } = payload as { id?: unknown; enabled?: unknown };
  if (typeof id !== "string" || typeof enabled !== "boolean") return;

  if (!enabled) {
    await current.remove(id);
    return;
  }

  await current.enable(id, () => fetchRealmSource(id, realm));
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
