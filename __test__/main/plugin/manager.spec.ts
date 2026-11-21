import { describe, expect, it } from "vitest";

import {
  PluginActivationStatus,
  PluginKind,
  PluginPreloadStatus,
} from "@shared/contracts/plugin-manager-api";
import type { Registry } from "@shared/plugin/registry";

import type { DiscoveredPlugin } from "../../../src/main/plugin/discover";
import { PluginLoader, PluginStatus } from "../../../src/main/plugin/loader";
import { PluginManager } from "../../../src/main/plugin/manager";
import type { PluginStateStore } from "../../../src/main/plugin/state";
import { installLoggerStub } from "../../helpers/globals";

installLoggerStub();

function createRegistry(): Registry {
  return { load: () => Promise.resolve({}), keys: () => [] } as unknown as Registry;
}

function discovered(id: string, kind: PluginKind, icon?: string): DiscoveredPlugin {
  return {
    metadata: {
      id,
      name: id,
      version: "1.0.0",
      icon,
      realms: { main: "main/index.mjs" },
    },
    source: `/plugins/${id}`,
    kind,
    entryPaths: { main: `/plugins/${id}/main/index.mjs` },
    tree: {} as DiscoveredPlugin["tree"],
  };
}

function createState(): PluginStateStore {
  const overrides = new Map<string, boolean>();
  return {
    isEnabled: (id, kind) => overrides.get(id) ?? kind === PluginKind.Builtin,
    setEnabled: async (id, enabled) => {
      overrides.set(id, enabled);
    },
  };
}

function createLoader(
  state: PluginStateStore,
  plugins: DiscoveredPlugin[],
  importModule?: (entryPath: string) => Promise<unknown>
): PluginLoader {
  return new PluginLoader({
    registry: createRegistry(),
    plugins,
    isEnabled: (id) => {
      const plugin = plugins.find((candidate) => candidate.metadata.id === id);
      return plugin ? state.isEnabled(id, plugin.kind) : false;
    },
    importModule: importModule ?? (async () => ({ activate() {} })),
  });
}

describe("PluginManager", () => {
  it("defaults built-in plugins on and user plugins off", async () => {
    const state = createState();
    const loader = createLoader(state, [
      discovered("builtin", PluginKind.Builtin),
      discovered("user", PluginKind.User),
    ]);
    await loader.activateAll();
    const manager = new PluginManager(loader, state);

    const { plugins } = manager.list();

    expect(plugins.find((plugin) => plugin.id === "builtin")).toMatchObject({
      kind: PluginKind.Builtin,
      enabled: true,
      status: PluginActivationStatus.Active,
    });
    expect(plugins.find((plugin) => plugin.id === "user")).toMatchObject({
      kind: PluginKind.User,
      enabled: false,
      status: PluginActivationStatus.Inactive,
    });
  });

  it("enables a user plugin and activates it", async () => {
    const state = createState();
    const plugins = [discovered("user", PluginKind.User)];
    const loader = createLoader(state, plugins);
    const manager = new PluginManager(loader, state);

    const next = await manager.setEnabled("user", true);

    expect(next.plugins[0]).toMatchObject({
      enabled: true,
      status: PluginActivationStatus.Active,
    });
    expect(state.isEnabled("user", PluginKind.User)).toBe(true);
  });

  it("disables a built-in plugin and deactivates it", async () => {
    const state = createState();
    const plugins = [discovered("builtin", PluginKind.Builtin)];
    const loader = createLoader(state, plugins);
    await loader.activateAll();
    const manager = new PluginManager(loader, state);

    const next = await manager.setEnabled("builtin", false);

    expect(next.plugins[0]).toMatchObject({
      enabled: false,
      status: PluginActivationStatus.Inactive,
    });
    expect(state.isEnabled("builtin", PluginKind.Builtin)).toBe(false);
  });

  it("reports a failed activation with its error", async () => {
    const state = createState();
    const plugins = [discovered("broken", PluginKind.User)];
    const loader = createLoader(state, plugins, async () => {
      throw new Error("boom");
    });
    const manager = new PluginManager(loader, state);

    const next = await manager.setEnabled("broken", true);
    const [entry] = next.plugins;

    expect(entry).toMatchObject({
      enabled: true,
      status: PluginActivationStatus.Failed,
    });
    expect(entry.error).toMatch(/boom/);
  });

  it("rejects an unknown plugin id", async () => {
    const state = createState();
    const loader = createLoader(state, []);
    const manager = new PluginManager(loader, state);

    await expect(manager.setEnabled("missing", true)).rejects.toThrow(/Unknown plugin/);
  });

  it("exposes the icon as an assets:// URL", () => {
    const state = createState();
    const loader = createLoader(state, [discovered("iconed", PluginKind.User, "icons/plugin.png")]);
    const manager = new PluginManager(loader, state);

    expect(manager.list().plugins[0]?.icon).toBe("assets://plugins/iconed/icons/plugin.png");
  });

  it("does not change activation when persisting the toggle fails", async () => {
    const base = createState();
    const state: PluginStateStore = {
      ...base,
      setEnabled: async () => {
        throw new Error("disk full");
      },
    };
    const loader = createLoader(state, [discovered("user", PluginKind.User)]);
    const manager = new PluginManager(loader, state);

    await expect(manager.setEnabled("user", true)).rejects.toThrow(/disk full/);

    expect(loader.plugins[0].status).toBe(PluginStatus.Disabled);
    expect(state.isEnabled("user", PluginKind.User)).toBe(false);
  });

  it("notifies when a preload plugin is toggled", async () => {
    const state = createState();
    const plugin = discovered("pre", PluginKind.User);
    plugin.metadata.realms.preload = "preload/index.cjs";
    const changes: Array<[string, boolean]> = [];
    const loader = createLoader(state, [plugin]);
    const manager = new PluginManager(loader, state, (id, enabled) => {
      changes.push([id, enabled]);
    });

    await manager.setEnabled("pre", true);
    await manager.setEnabled("pre", false);

    expect(changes).toEqual([
      ["pre", true],
      ["pre", false],
    ]);
  });

  it("reports a partial status when the preload realm fails", async () => {
    const state = createState();
    const plugin = discovered("pre", PluginKind.User);
    plugin.metadata.realms.preload = "preload/index.cjs";
    const loader = createLoader(state, [plugin]);
    const manager = new PluginManager(loader, state);

    await manager.setEnabled("pre", true);
    manager.setPreloadStatus(1, "pre", PluginPreloadStatus.Failed, "preload boom");

    expect(manager.list().plugins[0]).toMatchObject({
      status: PluginActivationStatus.Partial,
      preloadStatus: PluginPreloadStatus.Failed,
      preloadError: "preload boom",
    });
  });
});
