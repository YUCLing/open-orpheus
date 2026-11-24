import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  SETTINGS,
  type TrayClickBehavior,
  type WindowLifecycle,
  type WindowSizeLimitOverride,
} from "@shared/settings";

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

describe("initialize", () => {
  it("types known keys from their defaults and leaves unknown keys open", () => {
    // `expectTypeOf` is a no-op at runtime; the assertions are checked by tsc
    // (and by oxlint's type-aware rules in CI). The wrappers avoid reading the
    // store before `initialize` has run.
    expectTypeOf(() => kv.get(SETTINGS.kDesktopLyricsOpacity)).returns.toEqualTypeOf<
      Promise<number | undefined>
    >();
    expectTypeOf(() => kv.get(SETTINGS.kDiscordPresenceEnabled)).returns.toEqualTypeOf<
      Promise<boolean | undefined>
    >();
    expectTypeOf(() => kv.get(SETTINGS.kProxy)).returns.toEqualTypeOf<
      Promise<string | undefined>
    >();
    expectTypeOf(() => kv.get(SETTINGS.kPluginsEnabled)).returns.toEqualTypeOf<
      Promise<Record<string, unknown> | undefined>
    >();
    expectTypeOf(() => kv.get("nope.unknown")).returns.toEqualTypeOf<Promise<unknown>>();

    // Enumerated settings carry their union, not the widened default string.
    expectTypeOf(() => kv.get(SETTINGS.kTrayClickBehavior)).returns.toEqualTypeOf<
      Promise<TrayClickBehavior | undefined>
    >();
    expectTypeOf(() => kv.get(SETTINGS.kWindowLifecycle)).returns.toEqualTypeOf<
      Promise<WindowLifecycle | undefined>
    >();
    expectTypeOf(() => kv.get(SETTINGS.kWindowOverrideMainWindowSizeLimit)).returns.toEqualTypeOf<
      Promise<WindowSizeLimitOverride | undefined>
    >();

    const dynamicKey: string = SETTINGS.kProxy;
    expectTypeOf(() => kv.get(dynamicKey)).returns.toEqualTypeOf<Promise<unknown>>();

    expectTypeOf(() => kv.set(SETTINGS.kDesktopLyricsOpacity, 0.5)).returns.toEqualTypeOf<
      Promise<boolean>
    >();
    expectTypeOf(() =>
      kv.getMany([SETTINGS.kProxy, SETTINGS.kDesktopLyricsOpacity])
    ).returns.toMatchTypeOf<Promise<(string | number | undefined)[]>>();

    // A known key only accepts the value type inferred from its default.
    function invalidWrites() {
      // @ts-expect-error strings are not valid opacity values
      void kv.set(SETTINGS.kDesktopLyricsOpacity, "nope");
      // @ts-expect-error not a tray click behavior
      void kv.set(SETTINGS.kTrayClickBehavior, "minimize");
      // @ts-expect-error not a window lifecycle
      void kv.set(SETTINGS.kWindowLifecycle, "persistent");
      // @ts-expect-error the override is stored as a string, not a boolean
      void kv.set(SETTINGS.kWindowOverrideMainWindowSizeLimit, true);
    }
    void invalidWrites;
  });

  it("applies the default value of a known key", async () => {
    initialize();

    await expect(kv.get(SETTINGS.kTrayClickBehavior)).resolves.toBe("always-show-menu");
    await expect(kv.get(SETTINGS.kDesktopLyricsOpacity)).resolves.toBe(1);
    await expect(kv.get(SETTINGS.kDiscordPresenceEnabled)).resolves.toBe(false);
  });

  it("旧对象配置不会启用分享或被修改", async () => {
    const previous = { enabled: true };
    hoisted.values.set("discordPresence", previous);

    initialize();

    await expect(kv.get(SETTINGS.kDiscordPresenceEnabled)).resolves.toBe(false);
    expect(hoisted.values.get("discordPresence")).toBe(previous);
    expect(hoisted.store.set).not.toHaveBeenCalled();
    expect(hoisted.store.delete).not.toHaveBeenCalled();
  });

  it("keeps a stored value over the default", async () => {
    // "minimize" is not a `TrayClickBehavior`: reads are not validated against
    // the union, so a value written by an older build still comes back as is.
    hoisted.values.set(SETTINGS.kTrayClickBehavior, "minimize");
    initialize();

    await expect(kv.get(SETTINGS.kTrayClickBehavior)).resolves.toBe("minimize");
  });

  it("leaves keys without default as they are", async () => {
    initialize();

    await expect(kv.get(SETTINGS.kProxy)).resolves.toBeUndefined();
    await expect(kv.get("nope.unknown")).resolves.toBeUndefined();
  });

  it("forwards an array request to keyv untouched", async () => {
    initialize();
    hoisted.store.get.mockResolvedValueOnce(["stored"]);
    const keys = [SETTINGS.kDesktopLyricsOpacity, SETTINGS.kProxy, "nope.unknown"];

    // Defaults are only applied by `getMany`, not by this passthrough.
    await expect(kv.get(keys)).resolves.toEqual(["stored"]);
    expect(hoisted.store.get).toHaveBeenCalledWith(keys);
  });

  it("keeps stored values in the array form", async () => {
    initialize();
    hoisted.store.get.mockResolvedValueOnce([0.5, "http://proxy", "kept"]);

    await expect(
      kv.get([SETTINGS.kDesktopLyricsOpacity, SETTINGS.kProxy, "nope.unknown"])
    ).resolves.toEqual([0.5, "http://proxy", "kept"]);
  });

  it("fills defaults when many keys are read at once", async () => {
    initialize();

    await expect(
      kv.getMany([SETTINGS.kDesktopLyricsOpacity, SETTINGS.kProxy, "nope.unknown"])
    ).resolves.toEqual([1, undefined, undefined]);
  });

  it("emits the original key and value only after a successful set", async () => {
    initialize();
    const seen = recordEvents();
    const write = Promise.withResolvers<boolean>();
    const value = true;
    hoisted.store.set.mockReturnValueOnce(write.promise);

    const operation = kv.set(SETTINGS.kDiscordPresenceEnabled, value, 1500);
    await flush();
    expect(seen).toEqual([]);
    expect(hoisted.store.set).toHaveBeenLastCalledWith(
      SETTINGS.kDiscordPresenceEnabled,
      value,
      1500
    );

    write.resolve(true);
    await expect(operation).resolves.toBe(true);
    await flush();

    expect(seen).toEqual([
      { event: "change", data: { key: SETTINGS.kDiscordPresenceEnabled, value } },
    ]);
  });

  it("does not emit a change event when set returns false", async () => {
    initialize();
    const seen = recordEvents();
    hoisted.store.set.mockResolvedValueOnce(false);

    await expect(kv.set(SETTINGS.kDiscordPresenceEnabled, true)).resolves.toBe(false);
    await flush();

    expect(seen).toEqual([]);
  });

  it("preserves set errors without emitting a change event", async () => {
    initialize();
    const seen = recordEvents();
    const error = new Error("write failed");
    hoisted.store.set.mockRejectedValueOnce(error);

    await expect(kv.set(SETTINGS.kDiscordPresenceEnabled, true)).rejects.toBe(error);
    await flush();

    expect(seen).toEqual([]);
  });

  it("emits changes only for successful bulk writes with the original key and value", async () => {
    initialize();
    const seen = recordEvents();
    const entries = [
      { key: SETTINGS.kDiscordPresenceEnabled, value: true },
      { key: SETTINGS.kProxy, value: "failed" },
      { key: SETTINGS.kDesktopLyricsOpacity, value: 0.5 },
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
    initialize();
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
    initialize();
    const seen = recordEvents();

    hoisted.store.hooks.get("after:delete")?.({
      key: SETTINGS.kDiscordPresenceEnabled,
      value: false,
    });
    await flush();

    expect(seen).toEqual([]);
  });

  it("emits deletes only for successful entries in a partially failed bulk deletion", async () => {
    initialize();
    const seen = recordEvents();

    hoisted.store.hooks.get("after:delete")?.({
      key: [SETTINGS.kProxy, SETTINGS.kDiscordPresenceEnabled, SETTINGS.kDesktopLyricsOpacity],
      value: [true, false, true],
    });
    await flush();

    expect(seen).toEqual([
      { event: "delete", data: { key: SETTINGS.kProxy } },
      { event: "delete", data: { key: SETTINGS.kDesktopLyricsOpacity } },
    ]);
  });
});
