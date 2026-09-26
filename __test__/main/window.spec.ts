import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserWindow } from "electron";

/** Every TypeScript source file under `dir`, recursively. */
async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return collectSourceFiles(path);
      return entry.name.endsWith(".ts") ? [path] : [];
    })
  );
  return nested.flat();
}

/** The runtime shape of the fake window, used to drive events from tests. */
interface FakeWindowHandle {
  emit(event: string, ...args: unknown[]): void;
  destroyed: boolean;
}

const hoisted = vi.hoisted(() => ({
  platform: vi.fn(() => "linux" as NodeJS.Platform),
  desktop: vi.fn(() => 0),
  setInputRegion: vi.fn(() => true),
  lifecycle: { state: 0 },
  appOn: vi.fn(),
}));

vi.mock("node:os", () => ({ default: { platform: hoisted.platform } }));

vi.mock("@open-orpheus/window", () => ({
  DesktopEnvironment: { Wayland: 0, X11: 1, Windows: 2, Darwin: 3, Unknown: 4 },
  getDesktopEnvironment: hoisted.desktop,
  setInputRegion: hoisted.setInputRegion,
}));

vi.mock("../../src/main/lifecycle", () => ({
  LifecycleState: {
    Starting: 0,
    MainWindowCreated: 1,
    MainWindowLoaded: 2,
    Started: 3,
    Quitting: 4,
  },
  get state() {
    return hoisted.lifecycle.state;
  },
  events: { on: vi.fn() },
  setLifecycleState: vi.fn(),
}));

vi.mock("electron", () => {
  class FakeIpc {
    handle = vi.fn();
    on = vi.fn();
  }

  class FakeWebContents {
    ipc = new FakeIpc();
    setWindowOpenHandler = vi.fn();
    send = vi.fn();
  }

  class FakeBrowserWindow {
    static nextId = 1;
    readonly id = FakeBrowserWindow.nextId++;
    title = "";
    destroyed = false;
    webContents = new FakeWebContents();
    private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

    constructor(readonly options: unknown) {}

    on(event: string, listener: (...args: unknown[]) => void) {
      let set = this.listeners.get(event);
      if (!set) {
        set = new Set();
        this.listeners.set(event, set);
      }
      set.add(listener);
      return this;
    }

    off(event: string, listener: (...args: unknown[]) => void) {
      this.listeners.get(event)?.delete(listener);
      return this;
    }

    once(event: string, listener: (...args: unknown[]) => void) {
      const wrapped = (...args: unknown[]) => {
        this.off(event, wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    }

    emit(event: string, ...args: unknown[]) {
      for (const listener of [...(this.listeners.get(event) ?? [])]) {
        listener(...args);
      }
    }

    isDestroyed() {
      return this.destroyed;
    }
    isMaximized() {
      return false;
    }
    isFullScreen() {
      return false;
    }
    setMaximumSize = vi.fn();
    setMinimumSize = vi.fn();
    setAlwaysOnTop = vi.fn();
    setMenuBarVisibility = vi.fn();
    loadURL = vi.fn(() => Promise.resolve());

    setTitle(title: string) {
      this.title = title;
    }
    getNativeWindowHandle() {
      return Buffer.from([this.id, 0, 0, 0]);
    }
    show() {
      this.emit("show");
    }
    hide() {
      this.emit("hide");
    }
    close() {
      const event = {
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      this.emit("close", event);
      if (event.defaultPrevented) return;
      this.destroy();
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit("closed");
    }
  }

  return {
    app: { on: hoisted.appOn },
    BrowserWindow: FakeBrowserWindow,
    shell: { openExternal: vi.fn() },
  };
});

import { ManagedWindow, OnDemandWindow } from "../../src/main/window";

const WAYLAND = 0;
const X11 = 1;

function asFake(wnd: BrowserWindow | null): FakeWindowHandle & BrowserWindow {
  if (!wnd) throw new Error("expected a bound window");
  return wnd as unknown as FakeWindowHandle & BrowserWindow;
}

const regions = [{ x: 0, y: 0, width: 10, height: 10 }];

class TestWindow extends ManagedWindow {
  constructor() {
    super();
    this.createBrowserWindow({});
  }
}

class TestOnDemandWindow extends OnDemandWindow {
  createWindow(): BrowserWindow {
    return this.createBrowserWindow({});
  }
}

beforeEach(() => {
  vi.useRealTimers();
  hoisted.platform.mockReturnValue("linux");
  hoisted.desktop.mockReturnValue(WAYLAND);
  hoisted.setInputRegion.mockReset();
  hoisted.setInputRegion.mockReturnValue(true);
  hoisted.lifecycle.state = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("window ownership", () => {
  it("constructs every BrowserWindow inside the wrapper", async () => {
    const src = fileURLToPath(new URL("../../src", import.meta.url));
    const offenders: string[] = [];

    for (const file of await collectSourceFiles(src)) {
      if (file.endsWith(join("main", "window.ts"))) continue;
      const text = await readFile(file, "utf8");
      if (/\bnew BrowserWindow\b/.test(text)) {
        offenders.push(file.slice(src.length));
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("ManagedWindow lifetime", () => {
  it("resolves from a live window and releases it when it closes", () => {
    const managed = new TestWindow();
    const wnd = asFake(managed.window);

    expect(ManagedWindow.fromBrowserWindow(wnd)).toBe(managed);

    wnd.destroy();

    expect(wnd.destroyed).toBe(true);
    expect(managed.window).toBeNull();
    expect(ManagedWindow.fromBrowserWindow(wnd)).toBeUndefined();
  });

  it("emits unbind exactly once when the window closes", async () => {
    const managed = new TestWindow();
    const unbind = vi.fn();
    managed.on("unbind", unbind);
    const wnd = asFake(managed.window);

    wnd.destroy();
    wnd.destroy();
    // Emittery delivers its events in a later microtask.
    await new Promise((resolve) => setImmediate(resolve));

    expect(unbind).toHaveBeenCalledTimes(1);
  });

  it("does not wrap a window it created a second time", async () => {
    const managed = new TestWindow();
    const wnd = asFake(managed.window);
    const handler = hoisted.appOn.mock.calls.find(
      ([event]) => event === "browser-window-created"
    )?.[1] as (event: unknown, wnd: unknown) => void;

    expect(handler).toBeTypeOf("function");
    handler({}, wnd);
    await new Promise((resolve) => setImmediate(resolve));

    expect(ManagedWindow.fromBrowserWindow(wnd)).toBe(managed);
  });
});

describe("ManagedWindow close policy", () => {
  it("lets a default window close", () => {
    const managed = new TestWindow();
    const wnd = asFake(managed.window);

    wnd.close();

    expect(wnd.destroyed).toBe(true);
    expect(managed.window).toBeNull();
  });

  it("holds back a close the application wants to handle", () => {
    const notify = vi.fn();
    class ApprovingWindow extends ManagedWindow {
      constructor() {
        super();
        this.requestCloseApproval(notify);
        this.createBrowserWindow({});
      }
    }
    const managed = new ApprovingWindow();
    const wnd = asFake(managed.window);

    wnd.close();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(wnd.destroyed).toBe(false);
    expect(managed.window).toBe(wnd);
  });

  it("closes anyway while the application is quitting", () => {
    const notify = vi.fn();
    class ApprovingWindow extends ManagedWindow {
      constructor() {
        super();
        this.requestCloseApproval(notify);
        this.createBrowserWindow({});
      }
    }
    const managed = new ApprovingWindow();
    const wnd = asFake(managed.window);
    hoisted.lifecycle.state = 4; // LifecycleState.Quitting

    wnd.close();

    expect(notify).not.toHaveBeenCalled();
    expect(wnd.destroyed).toBe(true);
  });

  it("closes an on-demand window that is being dismissed", () => {
    const managed = new TestOnDemandWindow();
    managed.show();
    const wnd = asFake(managed.window);
    wnd.emit("ready-to-show");

    managed.hide();

    expect(wnd.destroyed).toBe(true);
    expect(managed.window).toBeNull();
  });
});

describe("ManagedWindow native state", () => {
  it("re-applies the input region when Wayland recreates the surface", () => {
    const managed = new TestWindow();
    const wnd = asFake(managed.window);

    expect(managed.setWindowInputRegion(regions)).toBe(true);
    expect(hoisted.setInputRegion).toHaveBeenCalledTimes(1);
    expect(hoisted.setInputRegion).toHaveBeenLastCalledWith(String(wnd.id), [
      { x: 0, y: 0, w: 10, h: 10 },
    ]);

    wnd.emit("show");

    expect(hoisted.setInputRegion).toHaveBeenCalledTimes(2);
    expect(hoisted.setInputRegion).toHaveBeenLastCalledWith(String(wnd.id), [
      { x: 0, y: 0, w: 10, h: 10 },
    ]);
  });

  it("retries until the surface accepts the state", async () => {
    vi.useFakeTimers();
    const managed = new TestWindow();
    const wnd = asFake(managed.window);

    hoisted.setInputRegion
      .mockReturnValueOnce(true) // the immediate apply
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    managed.setWindowInputRegion(regions);
    wnd.emit("show");

    expect(hoisted.setInputRegion).toHaveBeenCalledTimes(2); // immediate + first attempt

    await vi.advanceTimersByTimeAsync(0);
    expect(hoisted.setInputRegion).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(50);
    expect(hoisted.setInputRegion).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(1000);
    expect(hoisted.setInputRegion).toHaveBeenCalledTimes(4);
  });

  it("stops retrying once the surface is gone", () => {
    vi.useFakeTimers();
    const managed = new TestWindow();
    const wnd = asFake(managed.window);

    hoisted.setInputRegion.mockReturnValueOnce(true).mockReturnValue(false);

    managed.setWindowInputRegion(regions);
    wnd.emit("show");
    expect(hoisted.setInputRegion).toHaveBeenCalledTimes(2);

    wnd.emit("hide");
    vi.advanceTimersByTime(5000);

    expect(hoisted.setInputRegion).toHaveBeenCalledTimes(2);
  });

  it("clears the input region on show when it was cleared explicitly", () => {
    const managed = new TestWindow();
    const wnd = asFake(managed.window);

    managed.setWindowInputRegion([]);
    wnd.emit("show");

    expect(hoisted.setInputRegion).toHaveBeenLastCalledWith(
      String(wnd.id),
      null
    );
  });

  it("keeps X11 behaviour: apply once, never retry", () => {
    hoisted.desktop.mockReturnValue(X11);
    const managed = new TestWindow();
    const wnd = asFake(managed.window);

    expect(managed.setWindowInputRegion(regions)).toBe(true);
    expect(hoisted.setInputRegion).toHaveBeenCalledTimes(1);
    expect(hoisted.setInputRegion).toHaveBeenLastCalledWith(
      expect.any(Buffer),
      [{ x: 0, y: 0, w: 10, h: 10 }]
    );

    wnd.emit("show");

    expect(hoisted.setInputRegion).toHaveBeenCalledTimes(1);
  });

  it("reports the native result of an immediate apply", () => {
    hoisted.setInputRegion.mockReturnValue(false);
    const managed = new TestWindow();

    expect(managed.setWindowInputRegion(regions)).toBe(false);
  });
});

describe("OnDemandWindow recreation", () => {
  it("keeps native state across window recreation", async () => {
    const managed = new TestOnDemandWindow();
    const firstShow = managed.show();
    const first = asFake(managed.window);
    managed.setWindowInputRegion(regions);
    first.emit("ready-to-show");
    await firstShow;

    expect(hoisted.setInputRegion).toHaveBeenLastCalledWith(String(first.id), [
      { x: 0, y: 0, w: 10, h: 10 },
    ]);

    managed.hide();
    expect(managed.window).toBeNull();

    hoisted.setInputRegion.mockClear();
    const secondShow = managed.show();
    const second = asFake(managed.window);
    second.emit("ready-to-show");
    await secondShow;

    expect(second).not.toBe(first);
    expect(second.id).not.toBe(first.id);
    expect(hoisted.setInputRegion).toHaveBeenCalledWith(String(second.id), [
      { x: 0, y: 0, w: 10, h: 10 },
    ]);
  });
});
