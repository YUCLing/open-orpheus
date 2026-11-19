import { describe, expect, it, vi } from "vitest";

import {
  createPluginRegistry,
  createRegistry,
  PluginReadinessCycleError,
  type PluginRegistrySource,
} from "@shared/plugin/registry";

describe("createRegistry", () => {
  it("loads modules on demand", async () => {
    const module = { value: 1 };
    const loader = vi.fn(async () => module);
    const registry = createRegistry({ "@test/alpha": loader });

    await expect(registry.load("@test/alpha")).resolves.toBe(module);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("lists every key", () => {
    const registry = createRegistry({
      "@test/alpha": async () => ({}),
      "@test/beta": async () => ({}),
    });

    expect(registry.keys().sort()).toEqual(["@test/alpha", "@test/beta"]);
  });
});

describe("createPluginRegistry", () => {
  function sources(
    entries: Record<string, PluginRegistrySource>
  ): Map<string, PluginRegistrySource> {
    return new Map(Object.entries(entries));
  }

  it("loads exports without waiting for activation", async () => {
    const load = vi.fn(async () => ({ engine: "ready" }));
    const whenActive = vi.fn(() => new Promise<unknown>(() => {}));
    const registry = createPluginRegistry(sources({ a: { load, whenActive } }));

    await expect(registry.load("a")).resolves.toEqual({ engine: "ready" });
    expect(whenActive).not.toHaveBeenCalled();
  });

  it("waits for readiness only through whenActive", async () => {
    const whenActive = vi.fn(async () => ({ engine: "active" }));
    const registry = createPluginRegistry(sources({ a: { load: async () => ({}), whenActive } }));

    await expect(registry.whenActive("a")).resolves.toEqual({ engine: "active" });
    expect(whenActive).toHaveBeenCalledTimes(1);
  });

  it("reports a readiness cycle instead of deadlocking", async () => {
    const registry = createPluginRegistry(
      sources({
        a: { load: async () => ({}), whenActive: () => new Promise(() => {}) },
        b: { load: async () => ({}), whenActive: () => new Promise(() => {}) },
      })
    );

    void registry
      .forPlugin("a")
      .whenActive("b")
      .catch(() => {});
    await expect(registry.forPlugin("b").whenActive("a")).rejects.toBeInstanceOf(
      PluginReadinessCycleError
    );
  });

  it("removes readiness edges once a wait resolves", async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const registry = createPluginRegistry(
      sources({
        a: { load: async () => ({}), whenActive: () => gate },
        b: { load: async () => ({}), whenActive: async () => ({}) },
      })
    );

    // a waits for b and finishes; the edge must not linger.
    await registry.forPlugin("a").whenActive("b");

    // b waiting for a is not a cycle just because a previously waited for b.
    const second = registry.forPlugin("b").whenActive("a");
    release({});
    await expect(second).resolves.toEqual({});
  });

  it("rejects a plugin waiting on its own readiness", async () => {
    const registry = createPluginRegistry(
      sources({ a: { load: async () => ({}), whenActive: () => new Promise(() => {}) } })
    );

    await expect(registry.forPlugin("a").whenActive("a")).rejects.toThrow(/cycle/);
  });

  it("forgets a cached evaluation", async () => {
    let version = 1;
    const load = vi.fn(async () => ({ version }));
    const registry = createPluginRegistry(sources({ a: { load, whenActive: load } }));

    await expect(registry.load("a")).resolves.toEqual({ version: 1 });
    version = 2;
    registry.forget("a");
    await expect(registry.load("a")).resolves.toEqual({ version: 2 });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
