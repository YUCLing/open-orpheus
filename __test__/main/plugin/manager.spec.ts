import { describe, expect, it, vi } from "vitest";

import {
  PluginAvailabilityKind,
  PluginFailureStage,
  PluginKind,
  PluginLayer,
  PluginPresentationStatus,
  PluginRuntimeStateKind,
  type PluginDesiredState,
  type PluginRealmReport,
} from "@shared/contracts/plugin-manager-api";
import type { Registry } from "@shared/plugin/registry";

import type { DiscoveredPlugin } from "../../../src/main/plugin/discover";
import { resolvePluginCatalog } from "../../../src/main/plugin/catalog";
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

function createState(defaults: Record<string, boolean> = {}): PluginStateStore {
  const overrides = new Map<string, PluginDesiredState>();
  return {
    desired: (id, kind) =>
      overrides.get(id) ?? {
        enabled: kind === PluginKind.Builtin && defaults[id] === true,
        revision: 0,
      },
    isEnabled: (id, kind) => {
      const override = overrides.get(id);
      return override ? override.enabled : kind === PluginKind.Builtin && defaults[id] === true;
    },
    setEnabled: async (id, kind, enabled) => {
      const current = overrides.get(id) ?? {
        enabled: kind === PluginKind.Builtin && defaults[id] === true,
        revision: 0,
      };
      if (current.enabled === enabled) return current;
      const next = { enabled, revision: current.revision + 1 };
      overrides.set(id, next);
      return next;
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

function createManager(
  loader: PluginLoader,
  state: PluginStateStore,
  plugins: DiscoveredPlugin[],
  onDesiredChanged?: (id: string, realm: string, desired: PluginDesiredState) => void
): PluginManager {
  const catalog = resolvePluginCatalog(
    plugins.map((plugin) => ({
      layer: plugin.kind === PluginKind.Builtin ? PluginLayer.Builtin : PluginLayer.User,
      source: plugin.source,
      plugin,
    }))
  );
  return new PluginManager({ loader, state, catalog, onDesiredChanged });
}

function report(
  id: string,
  realm: string,
  desiredRevision: number,
  state: PluginRealmReport["state"]
): PluginRealmReport {
  return { realm, id, desiredRevision, attempt: 1, state };
}

describe("PluginManager", () => {
  it("uses a builtin default and leaves user plugins off", async () => {
    const state = createState({ builtin: true });
    const plugins = [
      discovered("builtin", PluginKind.Builtin),
      discovered("user", PluginKind.User),
    ];
    const loader = createLoader(state, plugins);
    await loader.activateAll();
    const manager = createManager(loader, state, plugins);

    const { plugins: entries } = manager.list();

    expect(entries.find((plugin) => plugin.id === "builtin")).toMatchObject({
      kind: PluginKind.Builtin,
      layer: PluginLayer.Builtin,
      enabled: true,
      presentation: PluginPresentationStatus.Running,
      main: { kind: PluginRuntimeStateKind.Running },
    });
    expect(entries.find((plugin) => plugin.id === "user")).toMatchObject({
      kind: PluginKind.User,
      layer: PluginLayer.User,
      enabled: false,
      presentation: PluginPresentationStatus.Disabled,
      main: { kind: PluginRuntimeStateKind.Stopped },
    });
  });

  it("enables a user plugin and converges without blocking the command", async () => {
    const state = createState();
    const plugins = [discovered("user", PluginKind.User)];
    const loader = createLoader(state, plugins);
    const manager = createManager(loader, state, plugins);

    const next = await manager.setEnabled("user", true);

    expect(next.plugins[0]).toMatchObject({ enabled: true, desired: { enabled: true } });
    await vi.waitFor(() =>
      expect(manager.list().plugins[0]?.presentation).toBe(PluginPresentationStatus.Running)
    );
  });

  it("disables a built-in plugin and deactivates it", async () => {
    const state = createState({ builtin: true });
    const plugins = [discovered("builtin", PluginKind.Builtin)];
    const loader = createLoader(state, plugins);
    await loader.activateAll();
    const manager = createManager(loader, state, plugins);

    await manager.setEnabled("builtin", false);

    expect(state.isEnabled("builtin", PluginKind.Builtin)).toBe(false);
    await vi.waitFor(() =>
      expect(manager.list().plugins[0]?.presentation).toBe(PluginPresentationStatus.Disabled)
    );
  });

  it("reports a failed activation with its error", async () => {
    const state = createState();
    const plugins = [discovered("broken", PluginKind.User)];
    const loader = createLoader(state, plugins, async () => {
      throw new Error("boom");
    });
    const manager = createManager(loader, state, plugins);

    await manager.setEnabled("broken", true);
    await vi.waitFor(() =>
      expect(manager.list().plugins[0]?.presentation).toBe(PluginPresentationStatus.Failed)
    );
    const [entry] = manager.list().plugins;

    expect(entry.main.error).toMatch(/boom/);
  });

  it("rejects an unknown plugin id", async () => {
    const state = createState();
    const loader = createLoader(state, []);
    const manager = createManager(loader, state, []);

    await expect(manager.setEnabled("missing", true)).rejects.toThrow(/Unknown plugin/);
  });

  it("exposes the icon as an assets:// URL", () => {
    const state = createState();
    const plugins = [discovered("iconed", PluginKind.User, "icons/plugin.png")];
    const loader = createLoader(state, plugins);
    const manager = createManager(loader, state, plugins);

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
    const plugins = [discovered("user", PluginKind.User)];
    const loader = createLoader(state, plugins);
    const manager = createManager(loader, state, plugins);

    await expect(manager.setEnabled("user", true)).rejects.toThrow(/disk full/);

    expect(loader.plugins[0].status).toBe(PluginStatus.Disabled);
    expect(state.isEnabled("user", PluginKind.User)).toBe(false);
  });

  it("notifies each declared secondary realm with a revision", async () => {
    const state = createState();
    const plugin = discovered("pre", PluginKind.User);
    plugin.metadata.realms.preload = "preload/index.cjs";
    plugin.metadata.realms["plugin-manager"] = "plugin-manager/index.cjs";
    const changes: Array<[string, string, boolean, number]> = [];
    const loader = createLoader(state, [plugin]);
    const manager = createManager(loader, state, [plugin], (id, realm, desired) => {
      changes.push([id, realm, desired.enabled, desired.revision]);
    });

    await manager.setEnabled("pre", true);
    await manager.setEnabled("pre", false);

    expect(changes).toEqual([
      ["pre", "preload", true, 1],
      ["pre", "plugin-manager", true, 1],
      ["pre", "preload", false, 2],
      ["pre", "plugin-manager", false, 2],
    ]);
  });

  it("reports a degraded status when an instantiated secondary realm fails", async () => {
    const state = createState();
    const plugin = discovered("pre", PluginKind.User);
    plugin.metadata.realms.preload = "preload/index.cjs";
    const loader = createLoader(state, [plugin]);
    const manager = createManager(loader, state, [plugin]);

    await manager.setEnabled("pre", true);
    await vi.waitFor(() =>
      expect(manager.list().plugins[0]?.main.kind).toBe(PluginRuntimeStateKind.Running)
    );

    manager.registerHost(7, "preload");
    manager.setRealmReport(
      7,
      report("pre", "preload", 1, {
        kind: PluginRuntimeStateKind.Failed,
        desiredRevision: 1,
        attempt: 1,
        stage: PluginFailureStage.Activate,
        error: "manager boom",
        retryable: true,
      })
    );

    const [entry] = manager.list().plugins;
    expect(entry.presentation).toBe(PluginPresentationStatus.Degraded);
    expect(entry.realms.preload).toMatchObject({
      declared: true,
      hostCount: 1,
      counts: { failed: 1 },
    });
    expect(entry.realms.preload.instances[0]?.state.error).toBe("manager boom");
  });

  it("treats a declared realm with no host window as neutral", async () => {
    const state = createState();
    const plugin = discovered("pre", PluginKind.User);
    plugin.metadata.realms.preload = "preload/index.cjs";
    const loader = createLoader(state, [plugin]);
    const manager = createManager(loader, state, [plugin]);

    await manager.setEnabled("pre", true);
    await vi.waitFor(() =>
      expect(manager.list().plugins[0]?.presentation).toBe(PluginPresentationStatus.Running)
    );

    const [entry] = manager.list().plugins;
    expect(entry.realms.preload).toEqual({
      declared: true,
      hostCount: 0,
      instances: [],
      counts: {},
    });
  });

  it("ignores reports from stale revisions or unregistered hosts", async () => {
    const state = createState();
    const plugin = discovered("pre", PluginKind.User);
    plugin.metadata.realms.preload = "preload/index.cjs";
    const loader = createLoader(state, [plugin]);
    const manager = createManager(loader, state, [plugin]);
    await manager.setEnabled("pre", true);

    manager.setRealmReport(
      9,
      report("pre", "preload", 1, {
        kind: PluginRuntimeStateKind.Running,
        desiredRevision: 1,
        attempt: 1,
      })
    );
    expect(manager.list().plugins[0]?.realms.preload.instances).toHaveLength(0);

    manager.registerHost(9, "preload");
    manager.setRealmReport(
      9,
      report("pre", "preload", 0, {
        kind: PluginRuntimeStateKind.Running,
        desiredRevision: 0,
        attempt: 1,
      })
    );
    expect(manager.list().plugins[0]?.realms.preload.instances).toHaveLength(0);
  });

  it("keeps a built-in usable and reports shadowed user duplicates", async () => {
    const state = createState();
    const builtin = discovered("same", PluginKind.Builtin);
    const user = discovered("same", PluginKind.User);
    user.source = "/data/plugins/same";
    const catalog = resolvePluginCatalog([
      { layer: PluginLayer.User, source: user.source, plugin: user },
      { layer: PluginLayer.Builtin, source: builtin.source, plugin: builtin },
    ]);
    const loader = createLoader(state, [builtin]);
    const manager = new PluginManager({ loader, state, catalog });

    const [entry] = manager.list().plugins;
    expect(entry).toMatchObject({
      id: "same",
      availability: { kind: PluginAvailabilityKind.Available },
    });
    expect(entry.shadowed).toEqual([{ layer: PluginLayer.User, path: "/data/plugins/same" }]);
  });

  it("marks same-layer duplicates unavailable and non-runnable", async () => {
    const state = createState();
    const first = discovered("dup", PluginKind.User);
    first.source = "/data/plugins/b";
    const second = discovered("dup", PluginKind.User);
    second.source = "/data/plugins/a";
    const catalog = resolvePluginCatalog([
      { layer: PluginLayer.User, source: first.source, plugin: first },
      { layer: PluginLayer.User, source: second.source, plugin: second },
    ]);
    const loader = createLoader(state, []);
    const manager = new PluginManager({ loader, state, catalog });

    const [entry] = manager.list().plugins;
    expect(entry.presentation).toBe(PluginPresentationStatus.Unavailable);
    expect(entry.availability).toEqual({
      kind: PluginAvailabilityKind.Conflict,
      paths: ["/data/plugins/a", "/data/plugins/b"],
    });
    await expect(manager.setEnabled("dup", true)).rejects.toThrow(/duplicate id/);
  });

  it("reports cleanup failure from a window instance", async () => {
    const state = createState();
    const plugin = discovered("pre", PluginKind.User);
    plugin.metadata.realms.preload = "preload/index.cjs";
    const loader = createLoader(state, [plugin]);
    const manager = createManager(loader, state, [plugin]);

    await manager.setEnabled("pre", true);
    manager.registerHost(5, "preload");
    await manager.setEnabled("pre", false);

    manager.setRealmReport(
      5,
      report("pre", "preload", 2, {
        kind: PluginRuntimeStateKind.Failed,
        desiredRevision: 2,
        attempt: 1,
        stage: PluginFailureStage.Deactivate,
        error: "cleanup boom",
        retryable: false,
      })
    );

    expect(manager.list().plugins[0]?.presentation).toBe(PluginPresentationStatus.CleanupFailed);
  });

  it("keeps a hung activation as stopping after disable", async () => {
    const state = createState();
    const plugin = discovered("slow", PluginKind.User);
    const catalog = resolvePluginCatalog([
      { layer: PluginLayer.User, source: plugin.source, plugin },
    ]);
    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [plugin],
      isEnabled: (id) => state.isEnabled(id, PluginKind.User),
      importModule: async () => ({
        activate: () => new Promise<void>(() => {}),
      }),
      activationTimeoutMs: 10,
    });
    const manager = new PluginManager({ loader, state, catalog });

    await manager.setEnabled("slow", true);
    await vi.waitFor(() =>
      expect(manager.list().plugins[0]?.main.kind).toBe(PluginRuntimeStateKind.Hung)
    );

    await manager.setEnabled("slow", false);

    expect(manager.list().plugins[0]?.presentation).toBe(PluginPresentationStatus.Stopping);
  });

  it("forwards retry to every declared window realm", async () => {
    const state = createState();
    const plugin = discovered("pre", PluginKind.User);
    plugin.metadata.realms.preload = "preload/index.cjs";
    plugin.metadata.realms["plugin-manager"] = "plugin-manager/index.cjs";
    const catalog = resolvePluginCatalog([
      { layer: PluginLayer.User, source: plugin.source, plugin },
    ]);
    const loader = createLoader(state, [plugin]);
    const retries: Array<[string, string]> = [];
    const manager = new PluginManager({
      loader,
      state,
      catalog,
      onRetryRequested: (id, realm) => retries.push([id, realm]),
    });

    await manager.setEnabled("pre", true);
    await manager.retry("pre");

    expect(retries).toEqual([
      ["pre", "preload"],
      ["pre", "plugin-manager"],
    ]);
  });

  it("retries without changing desired state", async () => {
    const state = createState();
    const plugins = [discovered("flaky", PluginKind.User)];
    let attempts = 0;
    const loader = createLoader(state, plugins, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("boom");
      return { activate() {} };
    });
    const manager = createManager(loader, state, plugins);

    await manager.setEnabled("flaky", true);
    await vi.waitFor(() =>
      expect(manager.list().plugins[0]?.presentation).toBe(PluginPresentationStatus.Failed)
    );

    await manager.retry("flaky");

    expect(manager.list().plugins[0]?.desired).toEqual({ enabled: true, revision: 1 });
    await vi.waitFor(() =>
      expect(manager.list().plugins[0]?.presentation).toBe(PluginPresentationStatus.Running)
    );
  });
});
