import { beforeEach, describe, expect, it, vi } from "vitest";

import { PluginKind } from "@shared/contracts/plugin-manager-api";

const { kv } = vi.hoisted(() => ({
  kv: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

vi.mock("../../../src/main/settings", () => ({ kv }));

import { PluginState } from "../../../src/main/plugin/state";

describe("PluginState", () => {
  beforeEach(() => {
    kv.get.mockReset().mockResolvedValue({});
    kv.set.mockReset().mockResolvedValue(undefined);
  });

  it("serializes concurrent writes for different plugins", async () => {
    const writes: Array<Record<string, boolean>> = [];
    kv.set.mockImplementation(async (_key, value: Record<string, boolean>) => {
      writes.push({ ...value });
    });
    const state = new PluginState();
    await state.load();

    await Promise.all([state.setEnabled("a", true), state.setEnabled("b", true)]);

    expect(state.isEnabled("a", PluginKind.User)).toBe(true);
    expect(state.isEnabled("b", PluginKind.User)).toBe(true);
    expect(writes.at(-1)).toEqual({ a: true, b: true });
  });

  it("defaults every plugin off until a builtin default is registered", async () => {
    const state = new PluginState();
    await state.load();

    expect(state.isEnabled("builtin", PluginKind.Builtin)).toBe(false);
    expect(state.isEnabled("user", PluginKind.User)).toBe(false);

    state.setDefault("builtin", true);

    expect(state.isEnabled("builtin", PluginKind.Builtin)).toBe(true);
    expect(state.isEnabled("user", PluginKind.User)).toBe(false);

    await state.setEnabled("builtin", false);
    expect(state.isEnabled("builtin", PluginKind.Builtin)).toBe(false);

    await state.setEnabled("builtin", true);
    expect(state.isEnabled("builtin", PluginKind.Builtin)).toBe(true);
  });
});
