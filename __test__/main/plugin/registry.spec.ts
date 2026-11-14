import { describe, expect, it, vi } from "vitest";

import { createRegistry } from "@shared/plugin/registry";

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
