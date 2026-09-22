import { describe, expect, it, vi } from "vitest";

// The real store is a native sqlite database behind keyv, so only the decorated
// keyv instance that `initialize` builds is under test here.
const hoisted = vi.hoisted(() => {
  type Hook = (data: Record<string, unknown>) => void;
  return {
    store: {
      get: vi.fn(async () => undefined as unknown),
      getMany: vi.fn(async (keys: string[]) => keys.map(() => undefined)),
      set: vi.fn(async () => true),
      delete: vi.fn(async () => true),
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
    KeyvHooks: { BEFORE_SET: "before:set", AFTER_DELETE: "after:delete" },
  };
});

vi.mock("@keyv/sqlite", () => ({ KeyvSqlite: class {} }));

import type { Database } from "@open-orpheus/database";

import { createSettingsService } from "@main/bootstrap/services/settings";

let settings: ReturnType<typeof createSettingsService>;

function initialize() {
  settings = createSettingsService({ database: { nativeDb: {} as Database } });
}

/** Emittery notifies listeners from a microtask, so drain the queue first. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function recordEvents() {
  const seen: { event: string; data: Record<string, unknown> }[] = [];
  for (const name of ["change", "delete"]) {
    (settings.events as unknown as EmitteryLike).on(
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

describe("createSettingsService", () => {
  it("applies the default value of a known key", async () => {
    initialize();

    await expect(settings.kv.get("tray.clickBehavior")).resolves.toBe(
      "always-show-menu"
    );
    await expect(settings.kv.get("desktopLyrics.opacity")).resolves.toBe(1);
  });

  it("keeps a stored value over the default", async () => {
    hoisted.store.get.mockResolvedValueOnce("minimize");
    initialize();

    await expect(settings.kv.get("tray.clickBehavior")).resolves.toBe(
      "minimize"
    );
  });

  it("leaves keys without default as they are", async () => {
    initialize();

    await expect(settings.kv.get("proxy")).resolves.toBeUndefined();
    await expect(settings.kv.get("nope.unknown")).resolves.toBeUndefined();
  });

  it("forwards an array request to keyv untouched", async () => {
    hoisted.store.get.mockResolvedValueOnce(["stored"]);
    initialize();
    const keys = ["desktopLyrics.opacity", "proxy", "nope.unknown"];

    // Defaults are only applied by `getMany`, not by this passthrough.
    await expect(settings.kv.get(keys)).resolves.toEqual(["stored"]);
    expect(hoisted.store.get).toHaveBeenCalledWith(keys);
  });

  it("keeps stored values in the array form", async () => {
    hoisted.store.get.mockResolvedValueOnce([0.5, "http://proxy", "kept"]);
    initialize();

    await expect(
      settings.kv.get(["desktopLyrics.opacity", "proxy", "nope.unknown"])
    ).resolves.toEqual([0.5, "http://proxy", "kept"]);
  });

  it("fills defaults when many keys are read at once", async () => {
    initialize();

    await expect(
      settings.kv.getMany(["desktopLyrics.opacity", "proxy", "nope.unknown"])
    ).resolves.toEqual([1, undefined, undefined]);
  });

  it("emits a change event before a set", async () => {
    initialize();
    const seen = recordEvents();

    hoisted.store.hooks.get("before:set")?.({ key: "proxy", value: "x" });
    await flush();

    expect(seen).toEqual([
      { event: "change", data: { key: "proxy", value: "x" } },
    ]);
  });

  it("emits one delete event per key", async () => {
    initialize();
    const seen = recordEvents();

    hoisted.store.hooks.get("after:delete")?.({ key: ["a", "b"] });
    hoisted.store.hooks.get("after:delete")?.({ key: "c" });
    await flush();

    expect(seen.map(({ event, data }) => [event, data.key as string])).toEqual([
      ["delete", "a"],
      ["delete", "b"],
      ["delete", "c"],
    ]);
  });
});
