import path from "node:path";

import { app, ipcMain, webContents } from "electron";

import { PluginKind, PluginPreloadStatus } from "@shared/contracts/plugin-manager-api";
import { LOADED_REALM_IDS } from "virtual:open-orpheus/realm-runtime";
import { toError } from "@shared/util";
import { load } from "virtual:open-orpheus/registry";

import { plugins as pluginsDir } from "../folders";
import { registerShutdownTask } from "../lifecycle";
import { checkEnvFlagPresent } from "../util/env";

import {
  discoverPluginSources,
  loadDiscoveredPlugin,
  type DiscoveredPlugin,
  type PluginLocation,
} from "./discover";
import { PluginLoader } from "./loader";
import { PluginManager } from "./manager";
import { PluginState } from "./state";
import { createRegistry } from "@shared/plugin/registry";

let pluginManager: PluginManager | null = null;

/** The installed plugin manager, or `null` when the plugin system is disabled. */
export function getPluginManager(): PluginManager | null {
  return pluginManager;
}

/**
 * Plugin locations, in discovery order.
 *
 * - Built-in plugins are built into `out/builtin-plugins` in development and
 *   copied into the app bundle (`app.asar/builtin-plugins`) for releases.
 * - User plugins live in the data directory (`folders.plugins`).
 *
 * This is an internal capability for now; there is no installer UI.
 */
function pluginLocations(): PluginLocation[] {
  const builtinDir = app.isPackaged
    ? path.join(app.getAppPath(), "builtin-plugins")
    : path.join(app.getAppPath(), "out", "builtin-plugins");

  return [
    { dir: builtinDir, kind: PluginKind.Builtin },
    { dir: pluginsDir, kind: PluginKind.User },
  ];
}

/**
 * Install the plugin system.
 *
 * Called once, after the startup services are initialized and before the main
 * window is created. Returns the loader so the caller can run `activateAll`
 * once the main window exists, or `null` when plugins are disabled.
 */
export async function installPluginSystem(): Promise<PluginLoader | null> {
  if (checkEnvFlagPresent("OPEN_ORPHEUS_DISABLE_PLUGINS")) {
    LOGGER.info("Plugin system disabled by OPEN_ORPHEUS_DISABLE_PLUGINS");
    return null;
  }

  const registry = createRegistry(load);
  const state = new PluginState();
  await state.load();
  const sources = await discoverPluginSources(pluginLocations());

  const plugins: DiscoveredPlugin[] = [];
  for (const source of sources) {
    try {
      plugins.push(await loadDiscoveredPlugin(source.source, source.kind));
    } catch (error) {
      LOGGER.error({ source: source.source, err: toError(error) }, "Failed to load plugin");
    }
  }

  for (const plugin of plugins) {
    if (plugin.kind === PluginKind.Builtin) {
      state.setDefault(plugin.metadata.id, plugin.metadata.builtin?.defaultEnabled === true);
    }
  }

  const notifyPluginManager = () => {
    for (const contents of webContents.getAllWebContents()) {
      contents.send("plugin.changed");
    }
  };

  const loader = new PluginLoader({
    registry,
    plugins,
    isEnabled: (id) => {
      const plugin = plugins.find((candidate) => candidate.metadata.id === id);
      return plugin ? state.isEnabled(id, plugin.kind) : false;
    },
    onChanged: notifyPluginManager,
  });
  pluginManager = new PluginManager(loader, state, (id, realm, enabled) => {
    for (const contents of webContents.getAllWebContents()) {
      contents.send("plugins.realmChanged", { realm, id, enabled });
    }
  });

  const watchedRealmSenders = new Set<number>();

  const isLoadedRealmId = (value: unknown): value is string =>
    typeof value === "string" && LOADED_REALM_IDS.includes(value);

  ipcMain.on("plugins.realmStatus", (event, payload: unknown) => {
    if (payload === null || typeof payload !== "object") return;
    const { realm, id, status, error } = payload as {
      realm?: unknown;
      id?: unknown;
      status?: unknown;
      error?: unknown;
    };
    if (
      !isLoadedRealmId(realm) ||
      typeof id !== "string" ||
      !Object.values(PluginPreloadStatus).includes(status as PluginPreloadStatus)
    ) {
      return;
    }

    const senderId = event.sender.id;
    pluginManager?.setRealmStatus(
      senderId,
      realm,
      id,
      status as PluginPreloadStatus,
      typeof error === "string" ? error : undefined
    );
    if (!watchedRealmSenders.has(senderId)) {
      watchedRealmSenders.add(senderId);
      event.sender.once("destroyed", () => {
        watchedRealmSenders.delete(senderId);
        pluginManager?.clearRealmStatus(senderId);
        notifyPluginManager();
      });
    }
    notifyPluginManager();
  });

  // Plugins are evaluated by each preload itself; only their discovered
  // sources cross IPC, keyed by realm and plugin id.
  const realmSources = new Map<string, Map<string, string>>();
  for (const realm of LOADED_REALM_IDS) {
    const sourcesForRealm = new Map<string, string>();
    for (const { plugin } of loader.plugins) {
      const entry = plugin.metadata.realms[realm];
      if (!entry) continue;
      try {
        sourcesForRealm.set(
          plugin.metadata.id,
          (await plugin.tree.readFile(entry)).toString("utf8")
        );
      } catch (error) {
        LOGGER.error(
          { pluginId: plugin.metadata.id, realm, err: toError(error) },
          "Failed to read plugin realm source"
        );
      }
    }
    realmSources.set(realm, sourcesForRealm);
  }

  ipcMain.handle("plugins.realm", (_event, realm: unknown) => {
    if (!isLoadedRealmId(realm)) return [];
    return [...(realmSources.get(realm)?.keys() ?? [])].filter(
      (id) => pluginManager?.isEnabled(id) ?? false
    );
  });
  ipcMain.handle("plugins.realmSource", (_event, realm: unknown, id: unknown) => {
    if (!isLoadedRealmId(realm) || typeof id !== "string" || !pluginManager?.isEnabled(id)) {
      return null;
    }
    return realmSources.get(realm)?.get(id) ?? null;
  });

  registerShutdownTask({
    name: "plugins",
    timeoutMs: 2000,
    run: () => loader.deactivateAll(),
  });

  LOGGER.info(
    { plugins: loader.plugins.length, sources: sources.length },
    "Plugin system installed"
  );
  return loader;
}
