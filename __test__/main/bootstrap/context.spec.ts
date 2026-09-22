import type { BrowserWindow } from "electron";
import { describe, expect, it } from "vitest";

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

  it("gives each context its own window service", async () => {
    const first = await createTestContext();
    const second = await createTestContext();
    const wnd = { id: 1 } as unknown as BrowserWindow;

    first.windows.setMainWindow(wnd);

    // The point of the composition root is that it builds an object graph. A
    // module-level window service made these two contexts share mutable state,
    // so a window set through one leaked into the other.
    expect(first.windows.current()).toBe(wnd);
    expect(second.windows.current()).toBeNull();
    expect(second.windows.currentWindow()).toBeNull();
  });

  it("does not hand the same window service object to two contexts", async () => {
    const first = await createTestContext();
    const second = await createTestContext();

    expect(first.windows).not.toBe(second.windows);
  });
});
