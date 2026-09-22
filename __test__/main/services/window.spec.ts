import type { BrowserWindow } from "electron";
import { describe, expect, it } from "vitest";

import { createWindowService } from "@main/services/window";

describe("createWindowService", () => {
  it("reports no window before one is set", () => {
    const windows = createWindowService();

    expect(windows.current()).toBeNull();
    expect(windows.currentWindow()).toBeNull();
  });

  it("reports the window it was given, through both accessors", () => {
    const windows = createWindowService();
    const wnd = { id: 1 } as unknown as BrowserWindow;

    windows.setMainWindow(wnd);

    expect(windows.current()).toBe(wnd);
    expect(windows.currentWindow()).toBe(wnd);
  });

  it("can be cleared again", () => {
    const windows = createWindowService();
    windows.setMainWindow({ id: 2 } as unknown as BrowserWindow);

    windows.setMainWindow(null);

    expect(windows.current()).toBeNull();
    expect(windows.currentWindow()).toBeNull();
  });

  it("starts empty even when another instance holds a window", () => {
    const first = createWindowService();
    const second = createWindowService();

    first.setMainWindow({ id: 3 } as unknown as BrowserWindow);

    expect(second.current()).toBeNull();
    expect(second.currentWindow()).toBeNull();
  });

  it("does not follow another instance back to null", () => {
    const first = createWindowService();
    const second = createWindowService();
    const wnd = { id: 4 } as unknown as BrowserWindow;

    second.setMainWindow(wnd);
    first.setMainWindow(null);

    expect(second.current()).toBe(wnd);
  });
});
