import { beforeEach, describe, expect, it, vi } from "vitest";

// The real store is a native sqlite database behind keyv, so only the decorated
// keyv instance that `initialize` builds is under test here.
const hoisted = vi.hoisted(() => {
  type Hook = (data: Record<string, unknown>) => void;
  return {
    values: new Map<string, unknown>(),
    store: {
      get: vi.fn<(key: string | string[]) => Promise<unknown>>(),
      getMany: vi.fn<(keys: string[]) => Promise<unknown[]>>(),
      set: vi.fn<(key: string, value: unknown, ttl?: number) => Promise<boolean>>(),
      delete: vi.fn<(key: string) => Promise<boolean>>(),
      /** Hooks registered through `onHook`, so the test can trigger them. */
      hooks: new Map<string, Hook>(),
    },
  };
});

vi.mock("keyv", () => {
  class Keyv {
    get = hoisted.store.get;
    getMany = hoisted.store.getMany;
    set = hoisted.store.set;
    delete = hoisted.store.delete;
    onHook(name: string, hook: (data: Record<string, unknown>) => void) {
      hoisted.store.hooks.set(name, hook);
    }
  }
  return {
    Keyv,
    KeyvHooks: { AFTER_SET_MANY: "after:setMany", AFTER_DELETE: "after:delete" },
  };
});

// `settings` registers a shutdown task; the real lifecycle module imports
// Electron, which is unnecessary here (and downloads the binary outside it).
vi.mock("../../src/main/lifecycle", () => ({
  registerShutdownTask: vi.fn(),
}));
vi.mock("../../src/main/database", () => ({ nativeDb: {} }));
vi.mock("../../src/main/database/KeyvSqliteDriver", () => ({
  default: vi.fn(() => ({})),
}));
vi.mock("@keyv/sqlite", () => ({ KeyvSqlite: class {} }));

import { events, initialize, kv } from "../../src/main/settings";

beforeEach(() => {
  hoisted.values.clear();
  hoisted.store.hooks.clear();
  hoisted.store.get
    .mockReset()
    .mockImplementation(async (key) =>
      Array.isArray(key) ? key.map((key) => hoisted.values.get(key)) : hoisted.values.get(key)
    );
  hoisted.store.getMany
    .mockReset()
    .mockImplementation(async (keys) => keys.map((key) => hoisted.values.get(key)));
  hoisted.store.set.mockReset().mockImplementation(async (key, value) => {
    hoisted.values.set(key, value);
    return true;
  });
  hoisted.store.delete.mockReset().mockImplementation(async (key) => hoisted.values.delete(key));
});

/** Emittery notifies listeners from a microtask, so drain the queue first. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function recordEvents() {
  const seen: { event: string; data: Record<string, unknown> }[] = [];
  for (const name of ["change", "delete"]) {
    (events as unknown as EmitteryLike).on(
      name,
      (event: { name: string; data: Record<string, unknown> }) => {
        seen.push({ event: event.name, data: event.data });
      }
    );
  }
  return seen;
}

type EmitteryLike = {
  on(
    name: string,
    listener: (event: { name: string; data: Record<string, unknown> }) => void
  ): void;
};

describe("Discord 开关迁移", () => {
  it.each([true, false])("将旧开关 %j 迁移一次并清理旧键", async (enabled) => {
    hoisted.values.set("discordPresence", { enabled, applicationId: "旧应用" });

    await initialize();
    await initialize();

    await expect(kv.get("discordPresence.enabled")).resolves.toBe(enabled);
    await expect(kv.getMany(["discordPresence.enabled"])).resolves.toEqual([enabled]);
    expect(hoisted.values.has("discordPresence")).toBe(false);
    expect(hoisted.store.set.mock.calls).toEqual([["discordPresence.enabled", enabled]]);
    expect(hoisted.store.delete.mock.calls).toEqual([["discordPresence"]]);
  });

  it.each([true, false, null, "true"])("新键明确值 %j 优先，不被旧开关覆盖", async (value) => {
    hoisted.values.set("discordPresence", { enabled: true });
    hoisted.values.set("discordPresence.enabled", value);

    await initialize();

    await expect(kv.get("discordPresence.enabled")).resolves.toBe(value);
    expect(hoisted.store.set).not.toHaveBeenCalled();
    expect(hoisted.values.has("discordPresence")).toBe(false);
  });

  it.each([null, {}, { enabled: "true" }])("旧配置 %j 无效时保持默认关闭", async (legacy) => {
    hoisted.values.set("discordPresence", legacy);

    await initialize();

    await expect(kv.get("discordPresence.enabled")).resolves.toBe(false);
    expect(hoisted.store.set).not.toHaveBeenCalled();
    expect(hoisted.store.delete).not.toHaveBeenCalled();
  });

  it("删除新键后重新初始化不会恢复旧的启用状态", async () => {
    hoisted.values.set("discordPresence", { enabled: true });
    await initialize();
    await expect(kv.delete("discordPresence.enabled")).resolves.toBe(true);

    await initialize();

    await expect(kv.get("discordPresence.enabled")).resolves.toBe(false);
    expect(hoisted.values.has("discordPresence")).toBe(false);
    expect(hoisted.store.set).toHaveBeenCalledOnce();
  });

  it.each(["false", "throw"])("复制新开关返回 %s 时初始化失败且不删除旧值", async (failure) => {
    const legacy = { enabled: true };
    hoisted.values.set("discordPresence", legacy);
    if (failure === "false") hoisted.store.set.mockResolvedValueOnce(false);
    else hoisted.store.set.mockRejectedValueOnce(new Error("写入失败"));

    await expect(initialize()).rejects.toThrow();

    expect(hoisted.values.get("discordPresence")).toEqual(legacy);
    expect(hoisted.values.has("discordPresence.enabled")).toBe(false);
    expect(hoisted.store.delete).not.toHaveBeenCalled();
  });

  it("清理旧键失败时初始化失败、保留旧值，下次可以继续清理", async () => {
    const legacy = { enabled: true };
    hoisted.values.set("discordPresence", legacy);
    hoisted.store.delete.mockResolvedValueOnce(false);

    await expect(initialize()).rejects.toThrow("无法清理旧 Discord 听歌状态设置");
    expect(hoisted.values.get("discordPresence")).toEqual(legacy);
    expect(hoisted.values.get("discordPresence.enabled")).toBe(true);

    await initialize();

    await expect(kv.get("discordPresence.enabled")).resolves.toBe(true);
    expect(hoisted.values.has("discordPresence")).toBe(false);
    expect(hoisted.store.set).toHaveBeenCalledOnce();
  });
});

describe("initialize", () => {
  it("applies the default value of a known key", async () => {
    await initialize();

    await expect(kv.get("tray.clickBehavior")).resolves.toBe("always-show-menu");
    await expect(kv.get("desktopLyrics.opacity")).resolves.toBe(1);
    await expect(kv.get("discordPresence.enabled")).resolves.toBe(false);
  });

  it("keeps a stored value over the default", async () => {
    hoisted.values.set("tray.clickBehavior", "minimize");
    await initialize();

    await expect(kv.get("tray.clickBehavior")).resolves.toBe("minimize");
  });

  it("leaves keys without default as they are", async () => {
    await initialize();

    await expect(kv.get("proxy")).resolves.toBeUndefined();
    await expect(kv.get("nope.unknown")).resolves.toBeUndefined();
  });

  it("forwards an array request to keyv untouched", async () => {
    await initialize();
    hoisted.store.get.mockResolvedValueOnce(["stored"]);
    const keys = ["desktopLyrics.opacity", "proxy", "nope.unknown"];

    // Defaults are only applied by `getMany`, not by this passthrough.
    await expect(kv.get(keys)).resolves.toEqual(["stored"]);
    expect(hoisted.store.get).toHaveBeenCalledWith(keys);
  });

  it("keeps stored values in the array form", async () => {
    await initialize();
    hoisted.store.get.mockResolvedValueOnce([0.5, "http://proxy", "kept"]);

    await expect(kv.get(["desktopLyrics.opacity", "proxy", "nope.unknown"])).resolves.toEqual([
      0.5,
      "http://proxy",
      "kept",
    ]);
  });

  it("fills defaults when many keys are read at once", async () => {
    await initialize();

    await expect(kv.getMany(["desktopLyrics.opacity", "proxy", "nope.unknown"])).resolves.toEqual([
      1,
      undefined,
      undefined,
    ]);
  });

  it("emits the original key and value only after a successful set", async () => {
    await initialize();
    const seen = recordEvents();
    const write = Promise.withResolvers<boolean>();
    const value = true;
    hoisted.store.set.mockReturnValueOnce(write.promise);

    const operation = kv.set("discordPresence.enabled", value, 1500);
    await flush();
    expect(seen).toEqual([]);
    expect(hoisted.store.set).toHaveBeenLastCalledWith("discordPresence.enabled", value, 1500);

    write.resolve(true);
    await expect(operation).resolves.toBe(true);
    await flush();

    expect(seen).toEqual([{ event: "change", data: { key: "discordPresence.enabled", value } }]);
  });

  it("does not emit a change event when set returns false", async () => {
    await initialize();
    const seen = recordEvents();
    hoisted.store.set.mockResolvedValueOnce(false);

    await expect(kv.set("discordPresence.enabled", true)).resolves.toBe(false);
    await flush();

    expect(seen).toEqual([]);
  });

  it("preserves set errors without emitting a change event", async () => {
    await initialize();
    const seen = recordEvents();
    const error = new Error("write failed");
    hoisted.store.set.mockRejectedValueOnce(error);

    await expect(kv.set("discordPresence.enabled", true)).rejects.toBe(error);
    await flush();

    expect(seen).toEqual([]);
  });

  it("emits changes only for successful bulk writes with the original key and value", async () => {
    await initialize();
    const seen = recordEvents();
    const entries = [
      { key: "discordPresence.enabled", value: true },
      { key: "proxy", value: "failed" },
      { key: "desktopLyrics.opacity", value: 0.5 },
    ];

    hoisted.store.hooks.get("after:setMany")?.({ entries, values: [true, false, true] });
    hoisted.store.hooks.get("after:setMany")?.({ entries, values: [false, false, false] });
    await flush();

    expect(seen).toEqual([
      { event: "change", data: entries[0] },
      { event: "change", data: entries[2] },
    ]);
  });

  it("emits one delete event per successfully deleted key", async () => {
    await initialize();
    const seen = recordEvents();

    hoisted.store.hooks.get("after:delete")?.({ key: ["a", "b"], value: [true, true] });
    hoisted.store.hooks.get("after:delete")?.({ key: "c", value: true });
    await flush();

    expect(seen.map(({ event, data }) => [event, data.key as string])).toEqual([
      ["delete", "a"],
      ["delete", "b"],
      ["delete", "c"],
    ]);
  });

  it("does not emit a delete event when the stored value could not be deleted", async () => {
    await initialize();
    const seen = recordEvents();

    hoisted.store.hooks.get("after:delete")?.({ key: "discordPresence.enabled", value: false });
    await flush();

    expect(seen).toEqual([]);
  });

  it("emits deletes only for successful entries in a partially failed bulk deletion", async () => {
    await initialize();
    const seen = recordEvents();

    hoisted.store.hooks.get("after:delete")?.({
      key: ["proxy", "discordPresence.enabled", "desktopLyrics.opacity"],
      value: [true, false, true],
    });
    await flush();

    expect(seen).toEqual([
      { event: "delete", data: { key: "proxy" } },
      { event: "delete", data: { key: "desktopLyrics.opacity" } },
    ]);
  });
});
