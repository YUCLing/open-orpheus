import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeWindow } from "../../../helpers/fakeWindow";

// The settings store needs a native sqlite database, so it is faked here.
vi.mock("@main/settings", async () => {
  const Emittery = (await import("emittery")).default;
  return {
    kv: {
      get: vi.fn(async (key: unknown) => `value:${String(key)}`),
      set: vi.fn(async () => true),
      setMany: vi.fn(async () => [true, false]),
      delete: vi.fn(async () => true),
      deleteMany: vi.fn(async () => [true]),
    },
    events: new Emittery(),
  };
});

import { registerSettingsHandlers } from "@main/bridge/modules/settings";
import { events, kv } from "@main/settings";

/** Emittery notifies listeners from a microtask, so drain the queue first. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("registerSettingsHandlers", () => {
  it("delegates every command to the keyv store", async () => {
    const win = createFakeWindow();
    registerSettingsHandlers(win.wnd);

    await expect(win.invoke("settings.get", "proxy")).resolves.toBe("value:proxy");
    await expect(win.invoke("settings.set", "proxy", "http://a")).resolves.toBe(true);
    await expect(win.invoke("settings.setMany", [{ key: "a", value: 1 }])).resolves.toEqual([
      true,
      false,
    ]);
    await expect(win.invoke("settings.delete", "proxy")).resolves.toBe(true);
    await expect(win.invoke("settings.deleteMany", ["a"])).resolves.toEqual([true]);

    expect(kv.get).toHaveBeenCalledWith("proxy");
    expect(kv.set).toHaveBeenCalledWith("proxy", "http://a");
    expect(kv.setMany).toHaveBeenCalledWith([{ key: "a", value: 1 }]);
    expect(kv.delete).toHaveBeenCalledWith("proxy");
    expect(kv.deleteMany).toHaveBeenCalledWith(["a"]);
  });

  it("forwards store changes to the renderer", async () => {
    const win = createFakeWindow();
    registerSettingsHandlers(win.wnd);

    void events.emit("change", { key: "proxy", value: "http://a" });
    await flush();

    expect(win.send).toHaveBeenCalledWith("settings.change", "proxy", "http://a");
  });

  it("forwards store deletions to the renderer", async () => {
    const win = createFakeWindow();
    registerSettingsHandlers(win.wnd);

    void events.emit("delete", { key: "proxy" });
    await flush();

    expect(win.send).toHaveBeenCalledWith("settings.delete", "proxy");
  });

  it("stops forwarding once the window is closed", async () => {
    const win = createFakeWindow();
    registerSettingsHandlers(win.wnd);

    win.close();
    void events.emit("change", { key: "proxy", value: 1 });
    void events.emit("delete", { key: "proxy" });
    await flush();

    expect(win.send).not.toHaveBeenCalled();
  });
});
