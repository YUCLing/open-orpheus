import { describe, expect, it, vi } from "vitest";

import { PluginPreloadStatus } from "@shared/contracts/plugin-manager-api";

import { evaluatePreloadModule, PreloadPluginLoader } from "../../../src/preload/plugin/loader";
import type { Registry } from "@shared/plugin/registry";
import { installLoggerStub } from "../../helpers/globals";

const logger = installLoggerStub();

function createRegistry(): Registry {
  return { load: () => Promise.resolve({}), keys: () => [] } as unknown as Registry;
}

const testGlobals = globalThis as typeof globalThis & {
  __preloadTest?: unknown;
  __preloadCross?: unknown;
  __preloadFirst?: unknown;
  __preloadSecond?: unknown;
  __preloadBDeactivated?: boolean;
  __preloadBDeactivate?: () => Promise<void>;
  __preloadAGateOff?: boolean;
  __preloadBGate?: Promise<void>;
};

describe("evaluatePreloadModule", () => {
  it("evaluates a CJS bundle with the provided require", () => {
    const fakeElectron = { ipcRenderer: {} };
    const module = evaluatePreloadModule(
      "module.exports = { electron: require('electron') };",
      "a",
      (id) => {
        if (id === "electron") return fakeElectron;
        throw new Error(`unexpected require ${id}`);
      }
    ) as { electron: unknown };

    expect(module.electron).toBe(fakeElectron);
  });

  it("propagates require errors", () => {
    expect(() =>
      evaluatePreloadModule("require('fs');", "a", (id) => {
        throw new Error(`blocked ${id}`);
      })
    ).toThrow(/blocked fs/);
  });
});

describe("PreloadPluginLoader", () => {
  it("evaluates and activates each preload plugin", async () => {
    delete testGlobals.__preloadTest;

    const loader = new PreloadPluginLoader({
      sources: new Map([
        [
          "a",
          "module.exports = { activate(runtime) { globalThis.__preloadTest = runtime; }, engine: 'exported' };",
        ],
      ]),
      registry: createRegistry(),
      evaluate: (source, id) => evaluatePreloadModule(source, id, () => ({})),
    });

    await loader.activateAll();

    expect(loader.plugins[0].status).toBe("active");
    const runtime = testGlobals.__preloadTest as {
      registry: Registry;
      plugins: { keys(): string[]; load(id: string): Promise<unknown> };
    };
    expect(runtime.registry).toBeDefined();
    expect(runtime.plugins.keys()).toEqual(["a"]);
    await expect(runtime.plugins.load("a")).resolves.toMatchObject({ engine: "exported" });

    await loader.deactivateAll();
    expect(loader.plugins[0].status).toBe("pending");
  });

  it("isolates a preload plugin that fails to export activate", async () => {
    const loader = new PreloadPluginLoader({
      sources: new Map([["bad", "module.exports = {};"]]),
      registry: createRegistry(),
      evaluate: (source, id) => evaluatePreloadModule(source, id, () => ({})),
    });

    await loader.activateAll();

    expect(loader.plugins[0].status).toBe("failed");
    expect(loader.plugins[0].error).toBeInstanceOf(Error);
    expect(logger.error).toHaveBeenCalled();
  });

  it("adds and removes a plugin at runtime", async () => {
    const deactivate = vi.fn();
    let runtime: { plugins: { keys(): string[]; load(id: string): Promise<unknown> } } | undefined;
    const loader = new PreloadPluginLoader({
      sources: new Map(),
      registry: createRegistry(),
      evaluate: () => ({
        activate(pluginRuntime: typeof runtime) {
          runtime = pluginRuntime;
        },
        deactivate,
      }),
    });

    await loader.add("late", "ignored");
    expect(loader.plugins).toHaveLength(1);
    expect(loader.plugins[0]).toMatchObject({ id: "late", status: "active" });
    expect(runtime?.plugins.keys()).toEqual(["late"]);

    await loader.remove("late");
    expect(loader.plugins).toHaveLength(0);
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(runtime?.plugins.keys()).toEqual([]);
  });

  it("waits for an in-flight activation before removing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deactivate = vi.fn();
    const loader = new PreloadPluginLoader({
      sources: new Map(),
      registry: createRegistry(),
      evaluate: () => ({
        async activate() {
          await gate;
        },
        deactivate,
      }),
    });

    const adding = loader.add("slow", "ignored");
    const removing = loader.remove("slow");
    release();
    await Promise.all([adding, removing]);

    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(loader.plugins).toHaveLength(0);
  });

  it("fetches the source inside the serialized enable operation", async () => {
    const deactivate = vi.fn();
    const getSource = vi.fn(async () => "module.exports = {};");
    const loader = new PreloadPluginLoader({
      sources: new Map(),
      registry: createRegistry(),
      evaluate: () => ({ activate() {}, deactivate }),
    });

    const enabling = loader.enable("late", getSource);
    const disabling = loader.remove("late");
    await Promise.all([enabling, disabling]);

    expect(getSource).toHaveBeenCalledTimes(1);
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(loader.plugins).toHaveLength(0);
  });

  it("registers all plugins before activating any", async () => {
    delete testGlobals.__preloadCross;
    const loader = new PreloadPluginLoader({
      sources: new Map(),
      registry: createRegistry(),
      evaluate: (source, id) => evaluatePreloadModule(source, id, () => ({})),
    });
    loader.registerAll(
      new Map([
        [
          "a",
          'module.exports = { async activate(runtime) { globalThis.__preloadCross = await runtime.plugins.load("b"); } };',
        ],
        ["b", 'module.exports = { activate() {}, engine: "b" };'],
      ])
    );

    await loader.activateAll();

    expect(testGlobals.__preloadCross).toMatchObject({ engine: "b" });
    expect(loader.plugins.find((record) => record.id === "a")?.status).toBe("active");
  });

  it("deactivates a partially activated preload module after activation throws", async () => {
    const deactivate = vi.fn();
    const loader = new PreloadPluginLoader({
      sources: new Map(),
      registry: createRegistry(),
      evaluate: () => ({
        async activate() {
          throw new Error("boom");
        },
        deactivate,
      }),
    });
    loader.registerAll(new Map([["partial", "ignored"]]));

    await loader.activateAll();

    expect(loader.plugins[0].status).toBe("failed");
    expect(deactivate).toHaveBeenCalledTimes(1);
  });

  it("reports activation and removal status", async () => {
    const statuses: Array<[string, PluginPreloadStatus, string | undefined]> = [];
    const loader = new PreloadPluginLoader({
      sources: new Map(),
      registry: createRegistry(),
      evaluate: () => ({ activate() {}, deactivate() {} }),
      onStatus: (id, status, error) => statuses.push([id, status, error]),
    });
    loader.registerAll(new Map([["a", "ignored"]]));

    await loader.activateAll();
    await loader.remove("a");

    expect(statuses).toEqual([
      ["a", PluginPreloadStatus.Active, undefined],
      ["a", PluginPreloadStatus.Inactive, undefined],
    ]);
  });

  it("does not delete a plugin re-enabled during cleanup", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deactivate = vi.fn(async () => {
      await gate;
    });
    const loader = new PreloadPluginLoader({
      sources: new Map(),
      registry: createRegistry(),
      evaluate: () => ({ activate() {}, deactivate }),
    });
    loader.registerAll(new Map([["a", "source"]]));
    await loader.activateAll();

    const removing = loader.remove("a");
    await vi.waitFor(() => expect(deactivate).toHaveBeenCalledTimes(1));
    const enabling = loader.enable("a", async () => "source");
    release();
    await Promise.all([removing, enabling]);

    expect(loader.plugins).toHaveLength(1);
    expect(loader.plugins[0].status).toBe("active");
  });

  it("drops the exports cache when re-enabled during cleanup", async () => {
    let releaseDeactivate!: () => void;
    const deactivateGate = new Promise<void>((resolve) => {
      releaseDeactivate = resolve;
    });
    delete testGlobals.__preloadFirst;
    delete testGlobals.__preloadSecond;
    delete testGlobals.__preloadBDeactivated;
    testGlobals.__preloadBDeactivate = async () => {
      testGlobals.__preloadBDeactivated = true;
      await deactivateGate;
    };

    const loader = new PreloadPluginLoader({
      sources: new Map([
        [
          "a",
          'module.exports = { async activate(runtime) { globalThis.__preloadFirst = (await runtime.plugins.load("b")).version; } };',
        ],
        [
          "b",
          "module.exports = { activate() {}, deactivate() { return globalThis.__preloadBDeactivate(); }, version: 1 };",
        ],
      ]),
      registry: createRegistry(),
      evaluate: (source, id) => evaluatePreloadModule(source, id, () => ({})),
    });
    await loader.activateAll();
    expect(testGlobals.__preloadFirst).toBe(1);

    const removing = loader.remove("b");
    await vi.waitFor(() => expect(testGlobals.__preloadBDeactivated).toBe(true));
    const enabling = loader.enable(
      "b",
      async () => "module.exports = { activate() {}, version: 2 };"
    );
    const loading = loader.add(
      "c",
      'module.exports = { async activate(runtime) { globalThis.__preloadSecond = (await runtime.plugins.load("b")).version; } };'
    );

    releaseDeactivate();
    await Promise.all([removing, enabling, loading]);

    expect(testGlobals.__preloadFirst).toBe(1);
    expect(testGlobals.__preloadSecond).toBe(2);
    expect(loader.plugins.find((record) => record.id === "b")?.status).toBe("active");
  });

  it("applies a disable while another plugin is still activating", async () => {
    let releaseB!: () => void;
    const bGate = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    delete testGlobals.__preloadAGateOff;
    testGlobals.__preloadBGate = bGate;

    const loader = new PreloadPluginLoader({
      sources: new Map([
        [
          "a",
          "module.exports = { activate() {}, deactivate() { globalThis.__preloadAGateOff = true; } };",
        ],
        ["b", "module.exports = { async activate() { await globalThis.__preloadBGate; } };"],
      ]),
      registry: createRegistry(),
      evaluate: (source, id) => evaluatePreloadModule(source, id, () => ({})),
    });

    loader.enableAll();
    await vi.waitFor(() =>
      expect(loader.plugins.find((record) => record.id === "a")?.status).toBe("active")
    );

    const removing = loader.remove("a");
    await vi.waitFor(() => expect(testGlobals.__preloadAGateOff).toBe(true));

    releaseB();
    await Promise.all([removing, loader.waitForAll()]);
  });
});
