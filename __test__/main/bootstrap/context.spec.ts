import { describe, expect, it, vi } from "vitest";

vi.mock("keyv", () => {
  class Keyv {
    get = vi.fn(async () => undefined);
    getMany = vi.fn(async (keys: string[]) => keys.map(() => undefined));
    set = vi.fn(async () => true);
    delete = vi.fn(async () => true);
    onHook = vi.fn();
  }
  return {
    Keyv,
    KeyvHooks: { BEFORE_SET: "before:set", AFTER_DELETE: "after:delete" },
  };
});
vi.mock("@keyv/sqlite", () => ({ KeyvSqlite: class {} }));
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/open-orpheus-test", isPackaged: false },
}));

import type { Database } from "@open-orpheus/database";
import type { BrowserWindow } from "electron";
import type { Logger } from "pino";

import { bootstrap } from "@main/bootstrap/context";
import { mainWindow, setMainWindow } from "@main/services/window";

const logger = {} as Logger;

function fakeDatabase() {
  return {
    executeSql: vi.fn(async () => ({})),
    executeSqls: vi.fn(async () => ({})),
    exec: vi.fn(async () => ({})),
  };
}

describe("bootstrap", () => {
  it("resolves to a ready phase carrying both services", async () => {
    const ctx = await bootstrap({
      logger,
      openDatabase: () => fakeDatabase() as unknown as Database,
    });

    expect(ctx.logger).toBe(logger);
    expect(ctx.database.nativeDb).toBeDefined();
    expect(ctx.settings.kv).toBeDefined();
    expect(ctx.settings.events).toBeDefined();
  });

  it("opens every database it hands back", async () => {
    const opened: string[] = [];
    const ctx = await bootstrap({
      logger,
      openDatabase: (path) => {
        opened.push(path);
        return fakeDatabase() as unknown as Database;
      },
    });

    expect(opened).toHaveLength(3);
    expect(Object.keys(ctx.database)).toHaveLength(3);
  });

  it("shares the main window it hands out with the window service", async () => {
    const ctx = await bootstrap({
      logger,
      openDatabase: () => fakeDatabase() as unknown as Database,
    });

    expect(mainWindow).toBeNull();

    const wnd = { id: 1 } as unknown as BrowserWindow;
    setMainWindow(wnd);

    expect(ctx.windows.current()).toBe(wnd);
    expect(mainWindow).toBe(wnd);
  });
});
