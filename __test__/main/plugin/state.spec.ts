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
    const writes: Array<Record<string, unknown>> = [];
    kv.set.mockImplementation(async (_key, value: Record<string, unknown>) => {
      writes.push(structuredClone(value));
    });
    const state = new PluginState();
    await state.load();

    await Promise.all([
      state.setEnabled("a", PluginKind.User, true),
      state.setEnabled("b", PluginKind.User, true),
    ]);

    expect(state.isEnabled("a", PluginKind.User)).toBe(true);
    expect(state.isEnabled("b", PluginKind.User)).toBe(true);
    expect(writes.at(-1)).toEqual({
      a: { enabled: true, revision: 1 },
      b: { enabled: true, revision: 1 },
    });
  });

  it("increments the revision for each committed change", async () => {
    const state = new PluginState();
    await state.load();

    expect(await state.setEnabled("a", PluginKind.User, true)).toEqual({
      enabled: true,
      revision: 1,
    });
    expect(await state.setEnabled("a", PluginKind.User, false)).toEqual({
      enabled: false,
      revision: 2,
    });
  });

  it("does not bump the revision for a repeated intent", async () => {
    const state = new PluginState();
    await state.load();

    await state.setEnabled("a", PluginKind.User, true);
    const repeated = await state.setEnabled("a", PluginKind.User, true);

    expect(repeated).toEqual({ enabled: true, revision: 1 });
    expect(kv.set).toHaveBeenCalledTimes(1);
  });

  it("defaults every plugin off until a builtin default is registered", async () => {
    const state = new PluginState();
    await state.load();

    expect(state.isEnabled("builtin", PluginKind.Builtin)).toBe(false);
    expect(state.isEnabled("user", PluginKind.User)).toBe(false);

    state.setDefault("builtin", true);

    expect(state.isEnabled("builtin", PluginKind.Builtin)).toBe(true);
    expect(state.isEnabled("user", PluginKind.User)).toBe(false);
    expect(state.desired("builtin", PluginKind.Builtin)).toEqual({ enabled: true, revision: 0 });

    await state.setEnabled("builtin", PluginKind.Builtin, false);
    expect(state.isEnabled("builtin", PluginKind.Builtin)).toBe(false);

    await state.setEnabled("builtin", PluginKind.Builtin, true);
    expect(state.isEnabled("builtin", PluginKind.Builtin)).toBe(true);
  });
});
