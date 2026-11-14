import { describe, expect, it, vi } from "vitest";

import { PluginKind } from "@shared/contracts/plugin-manager-api";
import type { Registry } from "@shared/plugin/registry";

import type { DiscoveredPlugin } from "../../../src/main/plugin/discover";
import { PluginLoader, PluginStatus } from "../../../src/main/plugin/loader";
import type { PluginModule, PluginRuntime } from "../../../src/main/plugin/types";
import { installLoggerStub } from "../../helpers/globals";

const logger = installLoggerStub();

function createRegistry(): Registry {
  return { load: vi.fn(), keys: () => [] } as unknown as Registry;
}

function discovered(
  id: string,
  entryPath = `/plugins/${id}/main/index.mjs`,
  kind = PluginKind.User
): DiscoveredPlugin {
  return {
    metadata: {
      id,
      name: id,
      version: "1.0.0",
      realms: { main: "main/index.mjs" },
    },
    source: `/plugins/${id}`,
    kind,
    entryPaths: { main: entryPath },
    tree: {} as DiscoveredPlugin["tree"],
  };
}

describe("PluginLoader", () => {
  it("imports and activates each plugin with the shared registry", async () => {
    const calls: string[] = [];
    const registry = createRegistry();
    const loader = new PluginLoader({
      registry,
      plugins: [discovered("a"), discovered("b")],
      importModule: async (entryPath) => ({
        activate(runtime: { registry: Registry }) {
          calls.push(`${entryPath}:${String(runtime.registry === registry)}`);
        },
      }),
    });

    await loader.activateAll();

    expect(calls).toEqual(["/plugins/a/main/index.mjs:true", "/plugins/b/main/index.mjs:true"]);
    expect(loader.plugins.map((record) => record.status)).toEqual([
      PluginStatus.Active,
      PluginStatus.Active,
    ]);
  });

  it("skips disabled plugins during activateAll", async () => {
    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [discovered("off"), discovered("on")],
      isEnabled: (id) => id === "on",
      importModule: async () => ({ activate() {} }),
    });

    await loader.activateAll();

    expect(loader.plugins.map((record) => record.status)).toEqual([
      PluginStatus.Disabled,
      PluginStatus.Active,
    ]);
  });

  it("activates and deactivates a single plugin by id", async () => {
    const calls: string[] = [];
    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [discovered("a")],
      importModule: async () => ({
        activate() {
          calls.push("activate");
        },
        deactivate() {
          calls.push("deactivate");
        },
      }),
    });

    await loader.activate("a");
    expect(loader.plugins[0].status).toBe(PluginStatus.Active);

    await loader.deactivate("a");
    expect(loader.plugins[0].status).toBe(PluginStatus.Disabled);
    expect(calls).toEqual(["activate", "deactivate"]);
  });

  it("isolates a plugin that fails to import or activate", async () => {
    const calls: string[] = [];
    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [discovered("bad"), discovered("good")],
      importModule: async (entryPath) => {
        if (entryPath.includes("/bad/")) throw new Error("boom");
        return { activate: () => calls.push("good") };
      },
    });

    await loader.activateAll();

    expect(calls).toEqual(["good"]);
    expect(loader.plugins.find((record) => record.plugin.metadata.id === "bad")?.status).toBe(
      PluginStatus.Failed
    );
    expect(loader.plugins.find((record) => record.plugin.metadata.id === "good")?.status).toBe(
      PluginStatus.Active
    );
    expect(logger.error).toHaveBeenCalled();
  });

  it("retries a failed plugin on activate", async () => {
    let attempts = 0;
    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [discovered("flaky")],
      importModule: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("boom");
        return { activate() {} };
      },
    });

    await loader.activate("flaky");
    expect(loader.plugins[0].status).toBe(PluginStatus.Failed);

    await loader.activate("flaky");
    expect(loader.plugins[0].status).toBe(PluginStatus.Active);
    expect(attempts).toBe(2);
  });

  it("rejects a module without an activate export", async () => {
    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [discovered("bad")],
      importModule: async () => ({}),
    });

    await loader.activateAll();

    expect(loader.plugins[0].status).toBe(PluginStatus.Failed);
    expect(loader.plugins[0].error).toBeInstanceOf(Error);
  });

  it("exposes plugin exports keyed by plugin id", async () => {
    let runtime: { plugins: { keys(): string[]; load(id: string): Promise<unknown> } } | undefined;
    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [discovered("a")],
      importModule: async () => ({
        engine: "exported",
        activate(value: typeof runtime) {
          runtime = value;
        },
      }),
    });

    await loader.activateAll();

    expect(runtime?.plugins.keys()).toEqual(["a"]);
    await expect(runtime?.plugins.load("a")).resolves.toMatchObject({ engine: "exported" });
    await expect(runtime?.plugins.load("missing")).rejects.toThrow(/Unknown plugin/);
  });

  it("keeps the first plugin for a duplicate id", () => {
    const first = discovered("dup");
    const second = discovered("dup", "/plugins/dup-2/main/index.mjs");
    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [first, second],
      importModule: async () => ({ activate() {} }),
    });

    expect(loader.plugins).toHaveLength(1);
    expect(loader.plugins[0].plugin).toBe(first);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("deactivates active plugins in reverse order", async () => {
    const calls: string[] = [];
    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [discovered("a"), discovered("b")],
      importModule: async (entryPath) => {
        const id = entryPath.split("/")[2];
        const module: PluginModule = {
          activate() {},
          deactivate() {
            calls.push(id);
          },
        };
        return module;
      },
    });

    await loader.activateAll();
    await loader.deactivateAll();

    expect(calls).toEqual(["b", "a"]);
    expect(loader.plugins.map((record) => record.status)).toEqual([
      PluginStatus.Disabled,
      PluginStatus.Disabled,
    ]);
  });

  it("skips failed plugins when deactivating", async () => {
    const calls: string[] = [];
    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [discovered("bad"), discovered("good")],
      importModule: async (entryPath) => {
        if (entryPath.includes("/bad/")) throw new Error("boom");
        return {
          activate() {},
          deactivate: () => calls.push("good"),
        };
      },
    });

    await loader.activateAll();
    await loader.deactivateAll();

    expect(calls).toEqual(["good"]);
  });

  it("serializes concurrent activation of the same plugin", async () => {
    let activations = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [discovered("slow")],
      importModule: async () => ({
        async activate() {
          activations += 1;
          await gate;
        },
      }),
    });

    const first = loader.activate("slow");
    const second = loader.activate("slow");
    release();
    await Promise.all([first, second]);

    expect(activations).toBe(1);
    expect(loader.plugins[0].status).toBe(PluginStatus.Active);
  });

  it("does not let deactivate overtake an in-flight activation", async () => {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [discovered("a")],
      importModule: async () => ({
        async activate() {
          calls.push("activate");
          await gate;
        },
        deactivate() {
          calls.push("deactivate");
        },
      }),
    });

    const activating = loader.activate("a");
    const deactivating = loader.deactivate("a");
    release();
    await Promise.all([activating, deactivating]);

    expect(calls).toEqual(["activate", "deactivate"]);
    expect(loader.plugins[0].status).toBe(PluginStatus.Disabled);
  });

  it("does not import a disabled plugin through the runtime registry", async () => {
    let imported = false;
    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [discovered("off"), discovered("on")],
      isEnabled: (id) => id === "on",
      importModule: async (entryPath) => {
        if (entryPath.includes("/off/")) imported = true;
        return {
          async activate(runtime: PluginRuntime) {
            await runtime.plugins.load("off").catch(() => {});
          },
        };
      },
    });

    await loader.activate("on");

    expect(imported).toBe(false);
    expect(loader.plugins.find((record) => record.plugin.metadata.id === "on")?.status).toBe(
      PluginStatus.Active
    );
  });

  it("deactivates a partially activated module after activation throws", async () => {
    const deactivate = vi.fn();
    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [discovered("partial")],
      importModule: async () => ({
        async activate() {
          throw new Error("boom");
        },
        deactivate,
      }),
    });

    await loader.activate("partial");

    expect(loader.plugins[0].status).toBe(PluginStatus.Failed);
    expect(deactivate).toHaveBeenCalledTimes(1);
  });

  it("retains a module whose cleanup fails and deactivates it later", async () => {
    const deactivate = vi
      .fn()
      .mockRejectedValueOnce(new Error("cleanup failed"))
      .mockResolvedValueOnce(undefined);
    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [discovered("partial")],
      importModule: async () => ({
        async activate() {
          throw new Error("boom");
        },
        deactivate,
      }),
    });

    await loader.activate("partial");
    expect(loader.plugins[0].status).toBe(PluginStatus.Failed);

    await loader.deactivate("partial");

    expect(deactivate).toHaveBeenCalledTimes(2);
    expect(loader.plugins[0].status).toBe(PluginStatus.Disabled);
  });

  it("times out one activation and continues with later plugins", async () => {
    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [discovered("slow"), discovered("fast")],
      activationTimeoutMs: 10,
      importModule: async (entryPath) => ({
        async activate() {
          if (entryPath.includes("/slow/")) await new Promise(() => {});
        },
      }),
    });

    await loader.activateAll();

    expect(loader.plugins.find((record) => record.plugin.metadata.id === "slow")?.status).toBe(
      PluginStatus.Failed
    );
    expect(loader.plugins.find((record) => record.plugin.metadata.id === "fast")?.status).toBe(
      PluginStatus.Active
    );
  });

  it("cleans up a timed-out activation when it eventually settles", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deactivate = vi.fn();
    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [discovered("slow")],
      activationTimeoutMs: 10,
      importModule: async () => ({
        async activate() {
          await gate;
        },
        deactivate,
      }),
    });

    await loader.activate("slow");
    expect(loader.plugins[0].status).toBe(PluginStatus.Failed);

    release();
    await vi.waitFor(() => expect(deactivate).toHaveBeenCalledTimes(1));
    expect(loader.plugins[0].module).toBeUndefined();
  });

  it("starts other plugins without waiting for a slow activation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [discovered("slow"), discovered("fast")],
      activationTimeoutMs: 1000,
      importModule: async (entryPath) => {
        if (entryPath.includes("/slow/")) {
          return {
            async activate() {
              await gate;
            },
          };
        }
        return { activate() {} };
      },
    });

    const all = loader.activateAll();
    await vi.waitFor(() =>
      expect(loader.plugins.find((record) => record.plugin.metadata.id === "fast")?.status).toBe(
        PluginStatus.Active
      )
    );
    release();
    await all;

    expect(loader.plugins.find((record) => record.plugin.metadata.id === "slow")?.status).toBe(
      PluginStatus.Active
    );
  });

  it("notifies when a main-realm lifecycle changes", async () => {
    const onChanged = vi.fn();
    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [discovered("a")],
      onChanged,
      importModule: async () => ({ activate() {} }),
    });

    await loader.activate("a");

    expect(onChanged).toHaveBeenCalled();
  });

  it("waits for a cross-plugin dependency to become active", async () => {
    let dependencyActivated = false;
    let sawActivatedDependency = false;
    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [discovered("a"), discovered("b")],
      importModule: async (entryPath) => {
        if (entryPath.includes("/b/")) {
          return {
            activate() {
              dependencyActivated = true;
            },
          };
        }
        return {
          async activate(runtime: PluginRuntime) {
            await runtime.plugins.load("b");
            sawActivatedDependency = dependencyActivated;
          },
        };
      },
    });

    await loader.activateAll();

    expect(sawActivatedDependency).toBe(true);
  });

  it("starts all shutdown cleanups within the shared deadline", async () => {
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const deactivateA = vi.fn(async () => {
      await gateA;
    });
    const deactivateB = vi.fn(async () => {
      await gateB;
    });
    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [discovered("a"), discovered("b")],
      importModule: async (entryPath) => ({
        activate() {},
        deactivate: entryPath.includes("/a/") ? deactivateA : deactivateB,
      }),
    });
    await loader.activateAll();

    const shuttingDown = loader.deactivateAll();
    await vi.waitFor(() => {
      expect(deactivateA).toHaveBeenCalled();
      expect(deactivateB).toHaveBeenCalled();
    });

    releaseA();
    releaseB();
    await shuttingDown;
  });

  it("clears the exports cache before waiting for deactivation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let loadedOldModule = false;
    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [discovered("a"), discovered("b"), discovered("c")],
      importModule: async (entryPath) => {
        if (entryPath.includes("/b/")) {
          return {
            activate() {},
            deactivate: async () => {
              await gate;
            },
          };
        }
        if (entryPath.includes("/c/")) {
          return {
            async activate(runtime: PluginRuntime) {
              try {
                await runtime.plugins.load("b");
                loadedOldModule = true;
              } catch {
                loadedOldModule = false;
              }
            },
          };
        }
        return {
          async activate(runtime: PluginRuntime) {
            await runtime.plugins.load("b");
          },
        };
      },
    });

    await loader.activate("a");
    const deactivating = loader.deactivate("b");
    await loader.activate("c");

    expect(loadedOldModule).toBe(false);

    release();
    await deactivating;
  });
});
