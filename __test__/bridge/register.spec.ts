import { describe, expect, it, vi } from "vitest";

import type { WebContents } from "electron";

import { registerIpcHandlers } from "@bridge/register";

function createFakeWebContents() {
  const handle = vi.fn();
  const removeHandler = vi.fn();
  return {
    handle,
    removeHandler,
    wc: { ipc: { handle, removeHandler } } as unknown as WebContents,
  };
}

describe("registerIpcHandlers", () => {
  it("registers flat handlers under the prefix", () => {
    const { handle, wc } = createFakeWebContents();
    const get = vi.fn();

    registerIpcHandlers(wc, "settings", { get, set: vi.fn() } as never);

    expect(handle).toHaveBeenCalledTimes(2);
    expect(handle.mock.calls.map(([channel]) => channel)).toEqual([
      "settings.get",
      "settings.set",
    ]);
    expect(handle.mock.calls[0][1]).toBe(get);
  });

  it("walks nested objects and joins the path with dots", () => {
    const { handle, wc } = createFakeWebContents();
    const play = vi.fn();

    registerIpcHandlers(wc, "player", {
      controls: { play, nested: { stop: vi.fn() } },
    } as never);

    expect(handle.mock.calls.map(([channel]) => channel)).toEqual([
      "player.controls.play",
      "player.controls.nested.stop",
    ]);
  });

  it("skips non-function leaves, nulls and arrays", () => {
    const { handle, wc } = createFakeWebContents();

    registerIpcHandlers(wc, "svc", {
      version: "1.0.0",
      enabled: true,
      missing: null,
      list: [1, 2, 3],
      items: [{ nested: true }],
    } as never);

    expect(handle).not.toHaveBeenCalled();
  });

  it("throws when two paths produce the same channel", () => {
    const { wc } = createFakeWebContents();

    expect(() =>
      registerIpcHandlers(wc, "svc", {
        "a.b": vi.fn(),
        a: { b: vi.fn() },
      } as never)
    ).toThrow('Duplicate IPC channel: "svc.a.b"');
  });

  it("ignores inherited properties", () => {
    const { handle, wc } = createFakeWebContents();
    const proto = { inherited: vi.fn() };
    const handlers = Object.assign(Object.create(proto), { own: vi.fn() });

    registerIpcHandlers(wc, "svc", handlers as never);

    expect(handle.mock.calls.map(([channel]) => channel)).toEqual(["svc.own"]);
  });

  describe("the returned handle", () => {
    it("removes every channel it registered", () => {
      const { removeHandler, wc } = createFakeWebContents();

      registerIpcHandlers(wc, "settings", {
        get: vi.fn(),
        nested: { set: vi.fn() },
      } as never).dispose();

      expect(removeHandler.mock.calls.map(([channel]) => channel)).toEqual([
        "settings.get",
        "settings.nested.set",
      ]);
    });

    it("removes nothing before it is disposed", () => {
      const { removeHandler, wc } = createFakeWebContents();

      registerIpcHandlers(wc, "settings", { get: vi.fn() } as never);

      expect(removeHandler).not.toHaveBeenCalled();
    });

    it("removes each channel once when disposed twice", () => {
      const { removeHandler, wc } = createFakeWebContents();
      const disposable = registerIpcHandlers(wc, "settings", {
        get: vi.fn(),
      } as never);

      disposable.dispose();
      disposable.dispose();

      expect(removeHandler).toHaveBeenCalledTimes(1);
    });

    it("removes nothing when no channel was registered", () => {
      const { removeHandler, wc } = createFakeWebContents();

      registerIpcHandlers(wc, "svc", { version: "1.0.0" } as never).dispose();

      expect(removeHandler).not.toHaveBeenCalled();
    });
  });
});
