import path from "node:path";

import { app, ipcMain, webContents } from "electron";

import {
  PluginKind,
  PluginLayer,
  PluginRuntimeStateKind,
  type PluginRealmBootstrap,
  type PluginRealmReport,
} from "@shared/contracts/plugin-manager-api";
import { LOADED_REALM_IDS } from "virtual:open-orpheus/realm-runtime";
import { toError } from "@shared/util";
import { load } from "virtual:open-orpheus/registry";

import { plugins as pluginsDir } from "../folders";
import { registerShutdownTask } from "../lifecycle";
import { checkEnvFlagPresent } from "../util/env";

import { resolvePluginCatalog, type PluginCandidate, type PluginCatalog } from "./catalog";
import {
  discoverPluginSources,
  loadDiscoveredPlugin,
  type PluginLocation,
} from "./discover";
import { PluginLoader } from "./loader";
import { PluginManager } from "./manager";
import { PluginState } from "./state";
import { createRegistry } from "@shared/plugin/registry";

let pluginManager: PluginManager | null = null;
let pluginCatalog: PluginCatalog | null = null;

/** The installed plugin manager, or `null` when the plugin system is disabled. */
export function getPluginManager(): PluginManager | null {
  return pluginManager;
}

/** The resolved plugin catalog, or `null` when the plugin system is disabled. */
export function getPluginCatalog(): PluginCatalog | null {
  return pluginCatalog;
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
  const candidates: PluginCandidate[] = [];
  for (const source of sources) {
    const layer =
      source.kind === PluginKind.Builtin ? PluginLayer.Builtin : PluginLayer.User;
    try {
      candidates.push({
        layer,
        source: source.source,
        plugin: await loadDiscoveredPlugin(source.source, source.kind),
      });
    } catch (error) {
      LOGGER.error({ source: source.source, err: toError(error) }, "Failed to load plugin");
      candidates.push({ layer, source: source.source, error });
    }
  }

  const catalog = resolvePluginCatalog(candidates);
  pluginCatalog = catalog;

  for (const plugin of catalog.selected.values()) {
    if (plugin.kind !== PluginKind.Builtin) continue;
    state.setDefault(plugin.metadata.id, plugin.metadata.builtin?.defaultEnabled === true);
  }

  const notifyPluginManager = () => {
    for (const contents of webContents.getAllWebContents()) {
      contents.send("plugin.changed");
    }
  };

  const selected = [...catalog.selected.values()];
  const loader = new PluginLoader({
    registry,
    plugins: selected,
    isEnabled: (id) => {
      const plugin = catalog.selected.get(id);
      return plugin ? state.isEnabled(id, plugin.kind) : false;
    },
    onChanged: notifyPluginManager,
  });

  const publishDesired = (
    id: string,
    realm: string,
    desired: { enabled: boolean; revision: number }
  ) => {
    const manager = pluginManager;
    if (!manager) return;
    for (const webContentsId of manager.hostsForRealm(realm)) {
      webContents.fromId(webContentsId)?.send("plugins.realmChanged", {
        realm,
        id,
        enabled: desired.enabled,
        revision: desired.revision,
      });
    }
  };

  pluginManager = new PluginManager({
    loader,
    state,
    catalog,
    onChanged: notifyPluginManager,
    onDesiredChanged: publishDesired,
  });

  const isLoadedRealmId = (value: unknown): value is string =>
    typeof value === "string" && LOADED_REALM_IDS.includes(value);

  const watchedHosts = new Set<number>();
  const watchHost = (webContentsId: number) => {
    if (watchedHosts.has(webContentsId)) return;
    watchedHosts.add(webContentsId);
    const sender = webContents.fromId(webContentsId);
    sender?.once("destroyed", () => {
      watchedHosts.delete(webContentsId);
      pluginManager?.unregisterHost(webContentsId);
      notifyPluginManager();
    });
  };

  // A realm window asks for one revisioned snapshot containing only enabled
  // plugins that declare it. Disabled sources are never read.
  ipcMain.handle("plugins.realmBootstrap", async (event, realm: unknown) => {
    if (!isLoadedRealmId(realm)) return null;
    const manager = pluginManager;
    if (!manager) return null;

    const webContentsId = event.sender.id;
    manager.registerHost(webContentsId, realm);
    watchHost(webContentsId);

    const bootstrap: PluginRealmBootstrap = { realm, plugins: [] };
    for (const plugin of catalog.selected.values()) {
      const entry = plugin.metadata.realms[realm];
      if (!entry) continue;
      const desired = manager.desiredFor(plugin.metadata.id);
      if (!desired?.enabled) continue;
      try {
        bootstrap.plugins.push({
          id: plugin.metadata.id,
          desired,
          source: (await plugin.tree.readFile(entry)).toString("utf8"),
        });
      } catch (error) {
        LOGGER.error(
          { pluginId: plugin.metadata.id, realm, err: toError(error) },
          "Failed to read plugin realm source"
        );
      }
    }
    return bootstrap;
  });

  // Live enables fetch a single bundle on demand.
  ipcMain.handle("plugins.realmSource", async (event, realm: unknown, id: unknown) => {
    if (!isLoadedRealmId(realm) || typeof id !== "string") return null;
    const manager = pluginManager;
    if (!manager || !manager.isHostFor(event.sender.id, realm)) return null;
    if (!manager.isEnabled(id)) return null;

    const plugin = catalog.selected.get(id);
    const entry = plugin?.metadata.realms[realm];
    if (!plugin || !entry) return null;
    try {
      return (await plugin.tree.readFile(entry)).toString("utf8");
    } catch (error) {
      LOGGER.error(
        { pluginId: id, realm, err: toError(error) },
        "Failed to read plugin realm source"
      );
      return null;
    }
  });

  const runtimeKinds = Object.values(PluginRuntimeStateKind);

  ipcMain.on("plugins.realmReport", (event, payload: unknown) => {
    const report = parseRealmReport(payload, isLoadedRealmId, runtimeKinds);
    if (!report) return;
    pluginManager?.setRealmReport(event.sender.id, report);
  });

  registerShutdownTask({
    name: "plugins",
    timeoutMs: 2000,
    run: async () => {
      await loader.deactivateAll();
    },
  });

  LOGGER.info(
    {
      plugins: loader.plugins.length,
      sources: sources.length,
      conflicts: catalog.entries.filter((entry) => entry.kind === "conflict").length,
      invalid: catalog.invalid.length,
    },
    "Plugin system installed"
  );
  return loader;
}

function parseRealmReport(
  payload: unknown,
  isLoadedRealmId: (value: unknown) => value is string,
  runtimeKinds: readonly PluginRuntimeStateKind[]
): PluginRealmReport | null {
  if (payload === null || typeof payload !== "object") return null;
  const { realm, id, desiredRevision, attempt, state } = payload as {
    realm?: unknown;
    id?: unknown;
    desiredRevision?: unknown;
    attempt?: unknown;
    state?: unknown;
  };
  if (!isLoadedRealmId(realm) || typeof id !== "string") return null;
  if (typeof desiredRevision !== "number" || typeof attempt !== "number") return null;
  if (state === null || typeof state !== "object") return null;
  const kind = (state as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !runtimeKinds.includes(kind as PluginRuntimeStateKind)) {
    return null;
  }
  return {
    realm,
    id,
    desiredRevision,
    attempt,
    state: state as PluginRealmReport["state"],
  };
}
