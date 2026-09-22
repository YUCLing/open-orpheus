import type { BrowserWindow } from "electron";
import { describe, expect, it } from "vitest";

import { mainWindow, setMainWindow } from "@main/services/window";
import {
  createFakeDatabase,
  createTestContext,
  createTestLogger,
} from "../../helpers/context";

describe("bootstrap", () => {
  it("resolves to a ready phase carrying both services", async () => {
    const ctx = await createTestContext();

    expect(ctx.database.nativeDb).toBeDefined();
    expect(ctx.settings.kv).toBeDefined();
    expect(ctx.settings.events).toBeDefined();
  });

  it("hands back the logger it was given", async () => {
    const logger = createTestLogger();

    const ctx = await createTestContext({ logger });

    expect(ctx.logger).toBe(logger);
  });

  it("opens every database it hands back", async () => {
    const opened: string[] = [];
    const ctx = await createTestContext({
      openDatabase: (path) => {
        opened.push(path);
        return createFakeDatabase();
      },
    });

    expect(opened).toHaveLength(3);
    expect(Object.keys(ctx.database)).toHaveLength(3);
  });

  it("shares the main window it hands out with the window service", async () => {
    const ctx = await createTestContext();

    expect(mainWindow).toBeNull();

    const wnd = { id: 1 } as unknown as BrowserWindow;
    setMainWindow(wnd);

    expect(ctx.windows.current()).toBe(wnd);
    expect(mainWindow).toBe(wnd);
  });
});
