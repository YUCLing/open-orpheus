import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserWindow } from "electron";

import Emittery from "emittery";

import type { SettingsService } from "@main/bootstrap/types";
import { registerSettingsHandlers } from "@bridge/common/settings";

// The settings store needs a native sqlite database, so a double stands in for it.
const kv = {
  get: vi.fn(async (key: unknown) => `value:${String(key)}`),
  set: vi.fn(async () => true),
  setMany: vi.fn(async () => [true, false]),
  delete: vi.fn(async () => true),
  deleteMany: vi.fn(async () => [true]),
};
const events = new Emittery();

const settings = { kv, events } as unknown as Pick<
  SettingsService,
  "kv" | "events"
>;

/** Emittery notifies listeners from a microtask, so drain the queue first. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function register(wnd: BrowserWindow) {
  registerSettingsHandlers(wnd, settings);
}

function createFakeWindow() {
  const send = vi.fn();
  const handle = vi.fn();
  const on = vi.fn();
  const wnd = {
    webContents: { send, ipc: { handle } },
    on,
  } as unknown as BrowserWindow;

  return {
    wnd,
    send,
    /** Invoke a handler registered through `ipc.handle` by channel name. */
    invoke(channel: string, ...args: unknown[]) {
      const call = handle.mock.calls.find(([name]) => name === channel);
      if (!call) throw new Error(`No handler registered for ${channel}`);
      return (call[1] as (...a: unknown[]) => unknown)({}, ...args);
    },
    /** Fire the `closed` listener installed by the handler. */
    close() {
      const call = on.mock.calls.find(([name]) => name === "closed");
      if (!call) throw new Error("No closed listener registered");
      return (call[1] as () => void)();
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("registerSettingsHandlers", () => {
  it("delegates every command to the keyv store", async () => {
    const win = createFakeWindow();
    register(win.wnd);

    await expect(win.invoke("settings.get", "proxy")).resolves.toBe(
      "value:proxy"
    );
    await expect(win.invoke("settings.set", "proxy", "http://a")).resolves.toBe(
      true
    );
    await expect(
      win.invoke("settings.setMany", [{ key: "a", value: 1 }])
    ).resolves.toEqual([true, false]);
    await expect(win.invoke("settings.delete", "proxy")).resolves.toBe(true);
    await expect(win.invoke("settings.deleteMany", ["a"])).resolves.toEqual([
      true,
    ]);

    expect(kv.get).toHaveBeenCalledWith("proxy");
    expect(kv.set).toHaveBeenCalledWith("proxy", "http://a");
    expect(kv.setMany).toHaveBeenCalledWith([{ key: "a", value: 1 }]);
    expect(kv.delete).toHaveBeenCalledWith("proxy");
    expect(kv.deleteMany).toHaveBeenCalledWith(["a"]);
  });

  it("forwards store changes to the renderer", async () => {
    const win = createFakeWindow();
    register(win.wnd);

    void events.emit("change", { key: "proxy", value: "http://a" });
    await flush();

    expect(win.send).toHaveBeenCalledWith(
      "settings.change",
      "proxy",
      "http://a"
    );
  });

  it("forwards store deletions to the renderer", async () => {
    const win = createFakeWindow();
    register(win.wnd);

    void events.emit("delete", { key: "proxy" });
    await flush();

    expect(win.send).toHaveBeenCalledWith("settings.delete", "proxy");
  });

  it("stops forwarding once the window is closed", async () => {
    const win = createFakeWindow();
    register(win.wnd);

    win.close();
    void events.emit("change", { key: "proxy", value: 1 });
    void events.emit("delete", { key: "proxy" });
    await flush();

    expect(win.send).not.toHaveBeenCalled();
  });
});
