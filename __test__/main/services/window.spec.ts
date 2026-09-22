import type { BrowserWindow } from "electron";
import { describe, expect, it } from "vitest";

import {
  mainWindow,
  mainWindowAccessor,
  setMainWindow,
  windowService,
} from "@main/services/window";

describe("window service", () => {
  it("reports no window before one is set", () => {
    setMainWindow(null);

    expect(windowService.current()).toBeNull();
    expect(windowService.currentWindow()).toBeNull();
    expect(mainWindowAccessor.current()).toBeNull();
    expect(mainWindow).toBeNull();
  });

  it("reports the window it was given", () => {
    const wnd = { id: 1 } as unknown as BrowserWindow;

    setMainWindow(wnd);

    expect(windowService.current()).toBe(wnd);
    expect(windowService.currentWindow()).toBe(wnd);
    expect(mainWindowAccessor.current()).toBe(wnd);
    expect(mainWindow).toBe(wnd);
  });

  it("can be cleared again", () => {
    setMainWindow({ id: 2 } as unknown as BrowserWindow);
    setMainWindow(null);

    expect(windowService.current()).toBeNull();
    expect(windowService.currentWindow()).toBeNull();
    expect(mainWindow).toBeNull();
  });

  it("keeps the service and the module binding in step", () => {
    const wnd = { id: 3 } as unknown as BrowserWindow;

    windowService.setMainWindow(wnd);

    expect(mainWindowAccessor.current()).toBe(wnd);
    expect(mainWindow).toBe(wnd);
  });
});
