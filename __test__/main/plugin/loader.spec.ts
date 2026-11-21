import { describe, expect, it, vi } from "vitest";

import { PluginKind } from "@shared/contracts/plugin-manager-api";
import type { Registry } from "@shared/plugin/registry";

import type { DiscoveredPlugin } from "../../../src/main/plugin/discover";
import { PluginLoader, PluginStatus } from "../../../src/main/plugin/loader";
import type { PluginModule, PluginRuntime } from "@shared/plugin/realms/main/index";
import { LifecycleStateKind } from "@shared/plugin/lifecycle";
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
      importModule: async (entryUrl) => ({
        activate(runtime: { registry: Registry }) {
          calls.push(`${entryUrl}:${String(runtime.registry === registry)}`);
        },
      }),
    });

    await loader.activateAll();

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^file:\/\/\/plugins\/a\/main\/index\.mjs\?t=\d+-[a-z0-9]+:true$/);
    expect(calls[1]).toMatch(/^file:\/\/\/plugins\/b\/main\/index\.mjs\?t=\d+-[a-z0-9]+:true$/);
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

  it("retries a failed plugin only through an explicit retry", async () => {
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
    expect(loader.plugins[0].status).toBe(PluginStatus.Failed);
    expect(attempts).toBe(1);

    await loader.retry("flaky");
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

  it("rejects duplicate ids because the catalog must resolve them first", () => {
    const first = discovered("dup");
    const second = discovered("dup", "/plugins/dup-2/main/index.mjs");

    expect(
      () =>
        new PluginLoader({
          registry: createRegistry(),
          plugins: [first, second],
          importModule: async () => ({ activate() {} }),
        })
    ).toThrow(/Duplicate plugin id/);
  });

  it("deactivates active plugins in reverse order", async () => {
    const calls: string[] = [];
    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [discovered("a"), discovered("b")],
      importModule: async (entryUrl) => {
        const id = new URL(entryUrl).pathname.split("/")[2];
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

    // The disable waits for the still-running activation; cleanup only starts
    // once that activation settles.
    void loader.deactivate("slow");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deactivate).not.toHaveBeenCalled();

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
            await runtime.plugins.whenActive("b");
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

  it("invalidates readiness when the manager disables via setDesiredState", async () => {
    let runtime: PluginRuntime | undefined;
    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [discovered("a"), discovered("b")],
      importModule: async (entryPath) => ({
        activate(value: PluginRuntime) {
          if (entryPath.includes("/b/")) runtime = value;
        },
        deactivate() {},
      }),
    });

    await loader.activate("a");
    await loader.activate("b");
    await expect(runtime?.plugins.whenActive("a")).resolves.toBeDefined();

    loader.setDesiredState("a", { enabled: false, revision: 1 });
    await vi.waitFor(() =>
      expect(loader.plugins.find((record) => record.plugin.metadata.id === "a")?.status).toBe(
        PluginStatus.Disabled
      )
    );

    await expect(runtime?.plugins.whenActive("a")).rejects.toThrow();
  });

  it("evaluates once per activation epoch and re-evaluates after re-enable", async () => {
    const urls: string[] = [];
    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [discovered("a")],
      importModule: async (entryUrl) => {
        urls.push(entryUrl);
        return { activate() {} };
      },
    });

    await loader.activate("a");
    expect(urls).toHaveLength(1);

    // Cross-plugin reads share the epoch's evaluation.
    await loader.activate("a");
    expect(urls).toHaveLength(1);

    await loader.deactivate("a");
    await loader.activate("a");

    expect(urls).toHaveLength(2);
    expect(urls[0]).not.toBe(urls[1]);
  });

  it("shares one cache-busted evaluation between activation and cross-plugin load", async () => {
    const urls: string[] = [];
    let loadedByA: unknown;
    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [discovered("a"), discovered("b")],
      importModule: async (entryUrl) => {
        urls.push(entryUrl);
        if (entryUrl.includes("/b/")) return { activate() {}, engine: "b" };
        return {
          async activate(runtime: PluginRuntime) {
            loadedByA = await runtime.plugins.load("b");
          },
        };
      },
    });

    await loader.activateAll();

    const moduleB = loader.plugins.find((record) => record.plugin.metadata.id === "b")?.module;
    expect(urls.filter((url) => url.includes("/b/"))).toHaveLength(1);
    expect(loadedByA).toBe(moduleB);
  });

  it("keeps the running module for cross-plugin load after a retry request", async () => {
    const imports = new Map<string, number>();
    let runtimeA: PluginRuntime | undefined;
    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [discovered("a"), discovered("b")],
      importModule: async (entryUrl) => {
        const id = new URL(entryUrl).pathname.split("/")[2];
        imports.set(id, (imports.get(id) ?? 0) + 1);
        if (id === "a") {
          return {
            activate(runtime: PluginRuntime) {
              runtimeA = runtime;
            },
          };
        }
        return { activate() {}, engine: "b" };
      },
    });

    await loader.activateAll();

    const first = await runtimeA!.plugins.load("b");
    const recordB = loader.plugins.find((record) => record.plugin.metadata.id === "b")!;
    expect(first).toBe(recordB.module);

    loader.requestRetry("b");

    expect(await runtimeA!.plugins.load("b")).toBe(first);
    expect(imports.get("b")).toBe(1);
  });

  it("keeps an in-flight activation's module through a disable/enable cycle", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let activations = 0;
    let activateStarted = false;
    let runtimeA: PluginRuntime | undefined;

    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [discovered("a"), discovered("b")],
      importModule: async (entryUrl) => {
        const id = new URL(entryUrl).pathname.split("/")[2];
        if (id === "a") {
          return {
            activate(runtime: PluginRuntime) {
              runtimeA = runtime;
            },
          };
        }
        activations += 1;
        return {
          async activate() {
            activateStarted = true;
            await gate;
          },
          engine: `b-${activations}`,
        };
      },
    });

    await loader.activate("a");
    const activating = loader.activate("b");
    await vi.waitFor(() => expect(activateStarted).toBe(true));

    loader.setDesiredState("b", { enabled: false, revision: 1 });
    loader.setDesiredState("b", { enabled: true, revision: 2 });

    const loadedDuringActivation = await runtimeA!.plugins.load("b");
    release();
    await activating;

    expect(loadedDuringActivation).toBe(await runtimeA!.plugins.whenActive("b"));
    expect(activations).toBe(1);
  });

  it("keeps one evaluation when an enable request repeats during cleanup", async () => {
    let releaseDeactivate!: () => void;
    const deactivation = new Promise<void>((resolve) => {
      releaseDeactivate = resolve;
    });
    let runtimeA: PluginRuntime | undefined;
    let activations = 0;

    const loader = new PluginLoader({
      registry: createRegistry(),
      plugins: [discovered("a"), discovered("b")],
      importModule: async (entryUrl) => {
        const id = new URL(entryUrl).pathname.split("/")[2];
        if (id === "a") {
          return {
            activate(runtime: PluginRuntime) {
              runtimeA = runtime;
            },
          };
        }
        activations += 1;
        return {
          activate() {},
          deactivate: () => deactivation,
          engine: `b-${activations}`,
        };
      },
    });

    await loader.activate("a");
    await loader.activate("b");

    const recordB = () => loader.plugins.find((record) => record.plugin.metadata.id === "b")!;

    loader.setDesiredState("b", { enabled: false, revision: 2 });
    await vi.waitFor(() => expect(recordB().snapshot.state.kind).toBe(LifecycleStateKind.Stopping));

    loader.setDesiredState("b", { enabled: true, revision: 3 });
    const early = await runtimeA!.plugins.load("b");

    // A repeated enable must not invalidate the evaluation this epoch owns.
    loader.setDesiredState("b", { enabled: true, revision: 4 });

    releaseDeactivate();
    await vi.waitFor(() => expect(recordB().status).toBe(PluginStatus.Active));

    expect(await runtimeA!.plugins.load("b")).toBe(early);
    expect(await runtimeA!.plugins.whenActive("b")).toBe(early);
    expect(activations).toBe(2);
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
                await runtime.plugins.whenActive("b");
                loadedOldModule = true;
              } catch {
                loadedOldModule = false;
              }
            },
          };
        }
        return {
          async activate(runtime: PluginRuntime) {
            await runtime.plugins.whenActive("b");
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
