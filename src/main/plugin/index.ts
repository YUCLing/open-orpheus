import path from "node:path";

import { app, ipcMain, webContents } from "electron";

import { PluginKind, PluginPreloadStatus } from "@shared/contracts/plugin-manager-api";
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
  pluginManager = new PluginManager(loader, state, (id, enabled) => {
    for (const contents of webContents.getAllWebContents()) {
      contents.send("plugins.preloadChanged", { id, enabled });
    }
  });

  const watchedPreloadSenders = new Set<number>();

  ipcMain.on("plugins.preloadStatus", (event, payload: unknown) => {
    if (payload === null || typeof payload !== "object") return;
    const { id, status, error } = payload as {
      id?: unknown;
      status?: unknown;
      error?: unknown;
    };
    if (
      typeof id !== "string" ||
      !Object.values(PluginPreloadStatus).includes(status as PluginPreloadStatus)
    ) {
      return;
    }

    const senderId = event.sender.id;
    pluginManager?.setPreloadStatus(
      senderId,
      id,
      status as PluginPreloadStatus,
      typeof error === "string" ? error : undefined
    );
    if (!watchedPreloadSenders.has(senderId)) {
      watchedPreloadSenders.add(senderId);
      event.sender.once("destroyed", () => {
        watchedPreloadSenders.delete(senderId);
        pluginManager?.clearPreloadStatus(senderId);
        notifyPluginManager();
      });
    }
    notifyPluginManager();
  });

  // Preload plugins are evaluated by the preload itself; only their discovered
  // sources cross IPC, keyed by plugin id.
  const preloadSources = new Map<string, string>();
  for (const { plugin } of loader.plugins) {
    const preload = plugin.metadata.realms.preload;
    if (!preload) continue;
    try {
      preloadSources.set(
        plugin.metadata.id,
        (await plugin.tree.readFile(preload)).toString("utf8")
      );
    } catch (error) {
      LOGGER.error(
        { pluginId: plugin.metadata.id, err: toError(error) },
        "Failed to read preload plugin source"
      );
    }
  }

  ipcMain.handle("plugins.preload", () =>
    [...preloadSources.keys()].filter((id) => pluginManager?.isEnabled(id) ?? false)
  );
  ipcMain.handle("plugins.preloadSource", (_event, id: unknown) => {
    if (typeof id !== "string" || !pluginManager?.isEnabled(id)) return null;
    return preloadSources.get(id) ?? null;
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
