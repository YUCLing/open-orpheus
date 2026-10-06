import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserWindow } from "electron";

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
  /** What the window was constructed with. */
  options: unknown;
}

const hoisted = vi.hoisted(() => {
  /**
   * Module-init registrations are captured in plain state rather than in mock
   * call history: Vitest clears every mock before each test, which would
   * otherwise wipe what `src/main/window.ts` registered when it was imported.
   */
  const layerShellRefusedCallbacks: unknown[] = [];
  const appOnCalls: Array<[string, unknown]> = [];
  const whenReadyPromises: Promise<unknown>[] = [];

  return {
    platform: vi.fn(() => "linux" as NodeJS.Platform),
    desktop: vi.fn(() => 0),
    setInputRegion: vi.fn(() => true),
    useLayerShell: vi.fn(() => true),
    showFailure: null as Error | null,
    cancelLayerShell: vi.fn(() => true),
    validateLayerShell: vi.fn(() => true),
    layerShellRefusedCallbacks,
    onLayerShellRefused: vi.fn((callback: unknown) => {
      layerShellRefusedCallbacks.push(callback);
    }),
    whenReadyPromises,
    whenReady: vi.fn(() => {
      const ready = Promise.resolve();
      whenReadyPromises.push(ready);
      return ready;
    }),
    /** Stands in for the native decoration of a managed title. */
    decorateTitle: vi.fn((id: string, title: string) => `#${id}#${title}`),
    layerShellAvailable: vi.fn(() => true),
    /** Layer-shell declarations made by the time a window was constructed. */
    layerCallsAtConstruction: [] as number[],
    lifecycle: { state: 0 },
    shutdownFinalizers: [] as Array<{ name: string; run: () => void }>,
    drainWindowCallbacks: vi.fn(),
    appOnCalls,
    appOn: vi.fn((event: string, handler: unknown) => {
      appOnCalls.push([event, handler]);
    }),
  };
});

vi.mock("node:os", () => ({ default: { platform: hoisted.platform } }));

vi.mock("@open-orpheus/window", () => ({
  DesktopEnvironment: { Wayland: 0, X11: 1, Windows: 2, Darwin: 3, Unknown: 4 },
  LayerShellLayer: { Background: 0, Bottom: 1, Top: 2, Overlay: 3 },
  getDesktopEnvironment: hoisted.desktop,
  setInputRegion: hoisted.setInputRegion,
  useLayerShellForNextWindow: hoisted.useLayerShell,
  cancelLayerShellForNextWindow: hoisted.cancelLayerShell,
  validateLayerShellOptions: hoisted.validateLayerShell,
  onLayerShellRoleRefused: hoisted.onLayerShellRefused,
  decorateWindowTitle: hoisted.decorateTitle,
  drainWindowCallbacks: hoisted.drainWindowCallbacks,
  isLayerShellAvailable: hoisted.layerShellAvailable,
}));

vi.mock("@main/services/lifecycle", () => ({
  LifecycleState: {
    Starting: 0,
    MainWindowCreated: 1,
    MainWindowLoaded: 2,
    Started: 3,
    Quitting: 4,
  },
  currentState: () => hoisted.lifecycle.state,
  get state() {
    return hoisted.lifecycle.state;
  },
  events: { on: vi.fn() },
  setLifecycleState: vi.fn(),
  registerShutdownFinalizer: (finalizer: { name: string; run: () => void }) => {
    hoisted.shutdownFinalizers.push(finalizer);
  },
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
    static byId = new Map<number, FakeBrowserWindow>();
    static fromId(id: number) {
      return FakeBrowserWindow.byId.get(id) ?? null;
    }
    readonly id = FakeBrowserWindow.nextId++;
    title = "";
    destroyed = false;
    visible = false;
    webContents = new FakeWebContents();
    private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

    constructor(readonly options: unknown) {
      const opts = (options ?? {}) as {
        x?: number;
        y?: number;
        width?: number;
        height?: number;
      };
      this.bounds = {
        x: opts.x ?? 0,
        y: opts.y ?? 0,
        width: opts.width ?? 0,
        height: opts.height ?? 0,
      };
      FakeBrowserWindow.byId.set(this.id, this);
      hoisted.layerCallsAtConstruction.push(hoisted.useLayerShell.mock.calls.length);
    }

    bounds: { x: number; y: number; width: number; height: number };
    getBounds() {
      return { ...this.bounds };
    }
    setBounds(next: { x: number; y: number; width: number; height: number }) {
      this.bounds = { ...next };
    }

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
      for (const listener of Array.from(this.listeners.get(event) ?? [])) {
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
    isVisible() {
      return this.visible;
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
      if (hoisted.showFailure) throw hoisted.showFailure;
      this.visible = true;
      this.emit("show");
    }
    showInactive() {
      if (hoisted.showFailure) throw hoisted.showFailure;
      this.visible = true;
      this.emit("show");
    }
    hide() {
      this.visible = false;
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
      this.visible = false;
      this.emit("closed");
    }
  }

  return {
    app: { on: hoisted.appOn, whenReady: hoisted.whenReady },
    BrowserWindow: FakeBrowserWindow,
    shell: { openExternal: vi.fn() },
  };
});

import { ManagedWindow, OnDemandWindow, switchWindowPolicy } from "@main/windows/managedWindow";
import { LayerShellLayer } from "@open-orpheus/window";
import type AppMenu from "@main/windows/menu";

const WAYLAND = 0;
const X11 = 1;

function asFake(wnd: BrowserWindow | null): FakeWindowHandle & BrowserWindow {
  if (!wnd) throw new Error("expected a bound window");
  return wnd as unknown as FakeWindowHandle & BrowserWindow;
}

/** The name the native layer knows the window by, from its bound window. */
function managedId(wnd: BrowserWindow): string {
  const managed = ManagedWindow.fromBrowserWindow(wnd);
  if (!managed) throw new Error("expected a managed window");
  return managed.id;
}

const regions = [{ x: 0, y: 0, width: 10, height: 10 }];

function fakeMenu() {
  const unsubscribe = vi.fn();
  const close = vi.fn();
  const on = vi.fn(() => unsubscribe);
  return { menu: { close, on } as unknown as AppMenu, close, unsubscribe };
}

class TestWindow extends ManagedWindow {
  constructor() {
    super();
    this.createBrowserWindow({});
  }

  /** Create another surface, the way a policy switch or a re-show would. */
  createSurface(): BrowserWindow {
    return this.createBrowserWindow({});
  }
}

class TestOnDemandWindow extends OnDemandWindow {
  createWindow(): BrowserWindow {
    return this.createBrowserWindow({});
  }
}

beforeEach(() => {
  hoisted.showFailure = null;
  vi.useRealTimers();
  hoisted.platform.mockReturnValue("linux");
  hoisted.desktop.mockReturnValue(WAYLAND);
  hoisted.setInputRegion.mockReset();
  hoisted.setInputRegion.mockReturnValue(true);
  hoisted.useLayerShell.mockReset();
  hoisted.useLayerShell.mockReturnValue(true);
  hoisted.cancelLayerShell.mockReset();
  hoisted.cancelLayerShell.mockReturnValue(true);
  hoisted.validateLayerShell.mockReset();
  hoisted.validateLayerShell.mockReturnValue(true);
  hoisted.decorateTitle.mockClear();
  hoisted.layerShellAvailable.mockReset();
  hoisted.layerShellAvailable.mockReturnValue(true);
  hoisted.layerCallsAtConstruction.length = 0;
  hoisted.lifecycle.state = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("window ownership", () => {
  it("retires callback reaping through the shared shutdown finalizer", () => {
    const finalizers = hoisted.shutdownFinalizers.filter(
      (entry) => entry.name === "window-callbacks"
    );
    expect(finalizers).toHaveLength(1);
    expect(hoisted.appOnCalls.some(([event]) => event === "will-quit")).toBe(false);
    const clear = vi.spyOn(globalThis, "clearInterval");
    hoisted.drainWindowCallbacks.mockClear();
    try {
      finalizers[0].run();
      expect(clear).toHaveBeenCalledOnce();
      expect(hoisted.drainWindowCallbacks).toHaveBeenCalledOnce();
    } finally {
      clear.mockRestore();
    }
  });

  it("constructs every BrowserWindow inside the wrapper", async () => {
    const src = fileURLToPath(new URL("../../src", import.meta.url));
    const offenders: string[] = [];

    for (const file of await collectSourceFiles(src)) {
      // The BrowserWindow wrapper moved here in the refactor; both names are
      // the same module.
      if (
        file.endsWith(join("main", "window.ts")) ||
        file.endsWith(join("main", "windows", "managedWindow.ts"))
      )
        continue;
      const text = await readFile(file, "utf8");
      if (/\bnew BrowserWindow\b/.test(text)) {
        offenders.push(file.slice(src.length));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("does not touch the settings emitter while the module is evaluated", async () => {
    // `settings.events` only exists after `settings.initialize()`, and these
    // modules are imported before that runs. Subscribing at module scope would
    // throw on startup, so registration has to happen from the startup path.
    const src = fileURLToPath(new URL("../../src", import.meta.url));
    const offenders: string[] = [];

    for (const name of ["mini-player.ts", "desktop-lyrics.ts"]) {
      const text = await readFile(join(src, "main", "windows", name), "utf8");
      for (const [index, line] of text.split("\n").entries()) {
        if (/^(?:settingsEvents|settings\.events)\.on\(/.test(line)) {
          offenders.push(`${name}:${index + 1}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("ManagedWindow menu ownership", () => {
  it("detaches old geometry listeners when rebinding the managed window", () => {
    const managed = new TestWindow();
    const old = asFake(managed.window);
    managed.createSurface();
    const menu = fakeMenu();
    managed.setMenu(menu.menu);
    for (const event of [
      "resize",
      "maximize",
      "unmaximize",
      "enter-full-screen",
      "leave-full-screen",
    ]) {
      old.emit(event);
    }
    expect(menu.close).not.toHaveBeenCalled();
    expect(managed.getData("menu")).toBe(menu.menu);
    asFake(managed.window).emit("resize");
    expect(menu.close).toHaveBeenCalledOnce();
    managed.destroy();
    old.destroy();
  });

  it.each(["resize", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"])(
    "closes only its parent's menu on %s and tolerates repeated geometry events",
    (event) => {
      const first = new TestWindow();
      const second = new TestWindow();
      const a = fakeMenu();
      const b = fakeMenu();
      first.setMenu(a.menu);
      second.setMenu(b.menu);
      (first.window as unknown as FakeWindowHandle).emit(event);
      (first.window as unknown as FakeWindowHandle).emit("resize");
      expect(a.close).toHaveBeenCalledOnce();
      expect(a.unsubscribe).toHaveBeenCalledOnce();
      expect(first.getData("menu")).toBeUndefined();
      expect(b.close).not.toHaveBeenCalled();
      expect(second.getData("menu")).toBe(b.menu);
      first.destroy();
      second.destroy();
    }
  );

  it("keeps different windows' menu lifetimes separate", () => {
    const first = new TestWindow();
    const second = new TestWindow();
    const a = fakeMenu();
    const b = fakeMenu();
    first.setMenu(a.menu);
    second.setMenu(b.menu);
    asFake(first.window).destroy();
    expect(a.close).toHaveBeenCalledOnce();
    expect(a.unsubscribe).toHaveBeenCalledOnce();
    expect(b.close).not.toHaveBeenCalled();
    expect(second.getData("menu")).toBe(b.menu);
  });

  it("closes the menu when its parent is hidden", () => {
    const managed = new TestWindow();
    const menu = fakeMenu();
    managed.setMenu(menu.menu);
    void managed.hide();
    expect(menu.close).toHaveBeenCalledOnce();
    expect(managed.getData("menu")).toBeUndefined();
  });

  it("does not carry a popup over to a replacement surface", () => {
    const managed = new TestWindow();
    const next = new TestWindow();
    const menu = fakeMenu();
    managed.setMenu(menu.menu);
    managed.transferStateTo(next);
    expect(menu.close).toHaveBeenCalledOnce();
    expect(next.getData("menu")).toBeUndefined();
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
    const handler = hoisted.appOnCalls.find(
      ([event]) => event === "browser-window-created"
    )?.[1] as (event: unknown, wnd: unknown) => void;

    expect(handler).toBeTypeOf("function");
    handler({}, wnd);
    await new Promise((resolve) => setImmediate(resolve));

    expect(ManagedWindow.fromBrowserWindow(wnd)).toBe(managed);
  });

  it.each(["managed", "external"] as const)(
    "does not bind a destroyed %s window during deferred registration",
    async (kind) => {
      const managed = kind === "managed" ? new TestWindow() : null;
      const wnd = managed ? asFake(managed.window) : asFake(new BrowserWindow({}));
      const handler = hoisted.appOnCalls.find(
        ([event]) => event === "browser-window-created"
      )?.[1] as (event: unknown, wnd: unknown) => void;
      const on = vi.spyOn(wnd, "on");

      handler({}, wnd);
      wnd.destroy();
      on.mockClear();
      await new Promise((resolve) => setImmediate(resolve));

      expect(ManagedWindow.fromBrowserWindow(wnd)).toBeUndefined();
      expect(on).not.toHaveBeenCalled();
      if (managed) expect(managed.window).toBeNull();
    }
  );

  it("still binds a live external window through deferred registration", async () => {
    const wnd = new BrowserWindow({});
    const handler = hoisted.appOnCalls.find(
      ([event]) => event === "browser-window-created"
    )?.[1] as (event: unknown, wnd: unknown) => void;

    handler({}, wnd);
    await new Promise((resolve) => setImmediate(resolve));

    const managed = ManagedWindow.fromBrowserWindow(wnd);
    expect(managed?.window).toBe(wnd);
    wnd.destroy();
    expect(managed?.window).toBeNull();
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
    void managed.show();
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
    expect(hoisted.setInputRegion).toHaveBeenLastCalledWith(managedId(wnd), [
      { x: 0, y: 0, w: 10, h: 10 },
    ]);

    wnd.emit("show");

    expect(hoisted.setInputRegion).toHaveBeenCalledTimes(2);
    expect(hoisted.setInputRegion).toHaveBeenLastCalledWith(managedId(wnd), [
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

    expect(hoisted.setInputRegion).toHaveBeenLastCalledWith(managedId(wnd), null);
  });

  it("re-sends the input region on X11 shows, in case the first call was early", () => {
    hoisted.desktop.mockReturnValue(X11);
    const managed = new TestWindow();
    const wnd = asFake(managed.window);

    expect(managed.setWindowInputRegion(regions)).toBe(true);
    expect(hoisted.setInputRegion).toHaveBeenCalledTimes(1);
    expect(hoisted.setInputRegion).toHaveBeenLastCalledWith(expect.any(Buffer), [
      { x: 0, y: 0, w: 10, h: 10 },
    ]);

    wnd.emit("show");

    expect(hoisted.setInputRegion).toHaveBeenCalledTimes(2);
    expect(hoisted.setInputRegion).toHaveBeenLastCalledWith(expect.any(Buffer), [
      { x: 0, y: 0, w: 10, h: 10 },
    ]);
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

    expect(hoisted.setInputRegion).toHaveBeenLastCalledWith(managedId(first), [
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
    expect(hoisted.setInputRegion).toHaveBeenCalledWith(managedId(second), [
      { x: 0, y: 0, w: 10, h: 10 },
    ]);
  });
});

describe("OnDemandWindow hiding", () => {
  /** Show the window and return its live surface. */
  async function showOnDemand(managed: TestOnDemandWindow) {
    const show = managed.show();
    const wnd = asFake(managed.window);
    wnd.emit("ready-to-show");
    await show;
    return wnd;
  }

  it("destroys and unbinds when it hides itself normally", async () => {
    const managed = new TestOnDemandWindow();
    const wnd = await showOnDemand(managed);

    // A raw hide still goes through the wrapper: the window is dismissed.
    wnd.hide();

    expect(wnd.destroyed).toBe(true);
    expect(managed.window).toBeNull();
  });

  it("stays bound while the app is quitting", async () => {
    const managed = new TestOnDemandWindow();
    const wnd = await showOnDemand(managed);

    hoisted.lifecycle.state = 4; // LifecycleState.Quitting
    wnd.hide();

    // The window is only off screen: a shutdown task may still need its
    // renderer, so it must not be destroyed or unbound.
    expect(wnd.destroyed).toBe(false);
    expect(managed.window).toBe(wnd);
  });
});

describe("switchWindowPolicy", () => {
  it("dismisses the old window and moves the recorded state", () => {
    const managed = new TestWindow();
    const previous = asFake(managed.window);
    managed.setData("name", "test_window");
    managed.setMinimumSize(320, 200);
    managed.setWindowInputRegion(regions);

    const next = switchWindowPolicy(managed, () => new TestWindow());
    const replacement = asFake(next.window);

    expect(previous.destroyed).toBe(true);
    expect(replacement).not.toBe(previous);
    expect(next.getData("name")).toBe("test_window");
    expect(next.getData("minimumSize")).toEqual({ x: 320, y: 200 });
    // The discarded wrapper keeps nothing, so `fromName` cannot find it.
    expect(managed.getData("name")).toBeUndefined();
    expect(ManagedWindow.fromName("test_window")).toBe(next);
  });

  it("re-applies the moved input region to the replacement", () => {
    const managed = new TestWindow();
    managed.setWindowInputRegion(regions);
    hoisted.setInputRegion.mockClear();

    const next = switchWindowPolicy(managed, () => new TestWindow());
    const replacement = asFake(next.window);
    replacement.emit("show");

    expect(hoisted.setInputRegion).toHaveBeenLastCalledWith(managedId(replacement), [
      { x: 0, y: 0, w: 10, h: 10 },
    ]);
  });

  it("keeps a visible window visible after the switch", () => {
    const managed = new TestWindow();
    asFake(managed.window).show();

    const next = switchWindowPolicy(managed, () => new TestWindow());

    expect(asFake(next.window).isVisible()).toBe(true);
  });

  it("leaves a hidden window to the new policy", () => {
    const managed = new TestWindow();

    const next = switchWindowPolicy(managed, () => new TestOnDemandWindow());

    // On-demand starts dismissed: no window until `show()`.
    expect(next).toBeInstanceOf(TestOnDemandWindow);
    expect(next.window).toBeNull();
  });

  it("recreates a visible on-demand window under the new policy", () => {
    const managed = new TestWindow();
    const previous = asFake(managed.window);
    previous.show();
    managed.setWindowInputRegion(regions);
    hoisted.setInputRegion.mockClear();

    const next = switchWindowPolicy(managed, () => new TestOnDemandWindow());
    const recreated = asFake(next.window);

    expect(previous.destroyed).toBe(true);
    expect(recreated).not.toBe(previous);

    recreated.emit("ready-to-show");
    expect(recreated.isVisible()).toBe(true);
    expect(hoisted.setInputRegion).toHaveBeenLastCalledWith(managedId(recreated), [
      { x: 0, y: 0, w: 10, h: 10 },
    ]);
  });

  it("keeps the position and size the window had", () => {
    const managed = new TestWindow();
    asFake(managed.window).setBounds({
      x: 40,
      y: 60,
      width: 500,
      height: 300,
    });

    const next = switchWindowPolicy(managed, () => new TestWindow());

    expect(asFake(next.window).getBounds()).toEqual({
      x: 40,
      y: 60,
      width: 500,
      height: 300,
    });
  });

  it("applies the moved state to a replacement that already exists", () => {
    const managed = new TestWindow();
    managed.setMinimumSize(320, 200);
    managed.setAlwaysOnTop(true);

    const next = switchWindowPolicy(managed, () => new TestWindow());
    const replacement = asFake(next.window);

    expect(replacement.setMinimumSize).toHaveBeenCalledWith(320, 200);
    expect(replacement.setAlwaysOnTop).toHaveBeenCalledWith(true);
  });

  it("shows the replacement of a window that was still waiting to appear", () => {
    const managed = new TestOnDemandWindow();
    void managed.show();
    expect(asFake(managed.window).isVisible()).toBe(false);

    const next = switchWindowPolicy(managed, () => new TestWindow());

    expect(asFake(next.window).isVisible()).toBe(true);
  });
});

describe("ManagedWindow layer shell", () => {
  const options = {
    namespace: "open-orpheus-test",
    layer: LayerShellLayer.Overlay,
    anchorTop: true,
    anchorBottom: true,
    anchorLeft: true,
    anchorRight: true,
  };

  it("declares the role before the surface is created", () => {
    class LayerWindow extends ManagedWindow {
      constructor() {
        super();
        this.setLayerShell(options);
        this.createBrowserWindow({});
      }
    }

    const managed = new LayerWindow();

    expect(managed.window).not.toBeNull();
    expect(hoisted.useLayerShell).toHaveBeenCalledWith(options, managed.id);
    expect(hoisted.layerCallsAtConstruction.at(-1)).toBeGreaterThan(0);
  });

  it("declares from the pre-create hook, without ordering requirements", () => {
    class HookWindow extends ManagedWindow {
      constructor() {
        super();
        this.createBrowserWindow({});
      }

      protected override beforeSurfaceCreated(): void {
        this.setLayerShell(options);
      }
    }

    const managed = new HookWindow();

    expect(managed.window).not.toBeNull();
    expect(hoisted.useLayerShell).toHaveBeenCalledWith(options, managed.id);
    expect(hoisted.layerCallsAtConstruction.at(-1)).toBeGreaterThan(0);
  });

  it("records the state without arming a declaration", () => {
    const managed = new TestWindow();
    hoisted.useLayerShell.mockClear();
    hoisted.cancelLayerShell.mockClear();

    expect(managed.setLayerShell(options)).toBe(true);

    expect(managed.layerShell).toEqual(options);
    expect(
      hoisted.useLayerShell,
      "a declaration may only be in flight while a surface is being created"
    ).not.toHaveBeenCalled();
  });

  it("arms for the show of a hidden window, which is what creates the surface", () => {
    const managed = new TestWindow();
    managed.setLayerShell(options);
    hoisted.useLayerShell.mockClear();

    void managed.show();

    expect(hoisted.useLayerShell).toHaveBeenCalledWith(options, managed.id);
  });

  it("arms once per surface, not once per show", () => {
    const managed = new TestWindow();
    managed.setLayerShell(options);
    hoisted.useLayerShell.mockClear();

    void managed.show();
    void managed.show();

    expect(hoisted.useLayerShell).toHaveBeenCalledTimes(1);
  });

  it("does not withdraw the native declaration when Electron emits show", () => {
    const managed = new TestWindow();
    managed.setLayerShell(options);
    hoisted.cancelLayerShell.mockClear();
    void managed.show();
    expect(hoisted.cancelLayerShell).not.toHaveBeenCalled();
    asFake(managed.window).emit("hide");
    expect(hoisted.cancelLayerShell).toHaveBeenCalledWith(managed.id);
  });

  it("withdraws by owner after a failed showInactive and can retry", () => {
    const managed = new TestWindow();
    managed.setLayerShell(options);
    const wnd = asFake(managed.window);
    hoisted.showFailure = new Error("show failed");
    expect(() => wnd.showInactive()).toThrow("show failed");
    expect(hoisted.cancelLayerShell).toHaveBeenCalledWith(managed.id);
    hoisted.showFailure = null;
    expect(() => wnd.showInactive()).not.toThrow();
    wnd.destroy();
    expect(hoisted.cancelLayerShell).toHaveBeenCalledWith(managed.id);
  });

  it("arms again after a hide, which takes the surface away", () => {
    const managed = new TestWindow();
    managed.setLayerShell(options);
    void managed.show();
    void managed.hide();
    hoisted.useLayerShell.mockClear();

    void managed.show();

    expect(hoisted.useLayerShell).toHaveBeenCalledWith(options, managed.id);
  });

  it("arms when another module shows the window directly", () => {
    const managed = new TestWindow();
    managed.setLayerShell(options);
    hoisted.useLayerShell.mockClear();

    // `menu.ts`, the `winhelper.*` calls and `app.ts` show the raw window.
    asFake(managed.window).show();

    expect(hoisted.useLayerShell).toHaveBeenCalledWith(options, managed.id);
  });

  it("arms when another module shows the window without focus", () => {
    const managed = new TestWindow();
    managed.setLayerShell(options);
    hoisted.useLayerShell.mockClear();

    asFake(managed.window).showInactive();

    expect(hoisted.useLayerShell).toHaveBeenCalledWith(options, managed.id);
  });

  it("surfaces a refused layer-shell role for its window", async () => {
    // The listener is registered once the app is ready.
    await hoisted.whenReadyPromises.at(-1);
    const managed = new TestWindow();
    managed.setLayerShell(options);
    const refused = managed.once("layerShellRefused");
    const reportRoleRefused = hoisted.layerShellRefusedCallbacks.at(-1) as (
      windowId: string
    ) => void;
    expect(reportRoleRefused).toBeTypeOf("function");

    // The native layer reports the managed id, not Electron's.
    reportRoleRefused(managed.id);

    // Emittery v2 hands listeners `{ name, data }`.
    const event = await refused;
    expect(event.name).toBe("layerShellRefused");
    expect(event.data).toBe(managed.window);
  });

  it("leaves a hidden window's surface to its first show", () => {
    class HiddenWindow extends ManagedWindow {
      constructor() {
        super();
        this.setLayerShell(options);
        this.createBrowserWindow({ show: false });
      }
    }

    const managed = new HiddenWindow();

    expect(hoisted.useLayerShell, "a hidden window has no surface yet").not.toHaveBeenCalled();

    void managed.show();

    expect(hoisted.useLayerShell).toHaveBeenCalledWith(options, managed.id);
  });

  it("arms for an on-demand window's first show", () => {
    class OnDemandLayerWindow extends TestOnDemandWindow {
      protected override beforeSurfaceCreated(): void {
        this.setLayerShell(options);
      }
    }

    const managed = new OnDemandLayerWindow();
    hoisted.useLayerShell.mockClear();

    void managed.show();
    // The window is created hidden and shown once it can be displayed.
    asFake(managed.window).emit("ready-to-show");

    expect(hoisted.useLayerShell).toHaveBeenCalledWith(options, managed.id);
    expect(asFake(managed.window).isVisible()).toBe(true);
  });

  it("leaves another window's declaration in the queue", () => {
    const layer = new TestWindow();
    layer.setLayerShell(options);
    layer.createSurface();
    hoisted.useLayerShell.mockClear();
    hoisted.cancelLayerShell.mockClear();

    // Declarations are handed out oldest first, so a window that declares
    // nothing must neither arm one nor withdraw one that is not its own.
    const ordinary = new TestWindow();

    expect(ordinary.layerShell).toBeNull();
    expect(hoisted.useLayerShell).not.toHaveBeenCalled();
    expect(hoisted.cancelLayerShell).not.toHaveBeenCalled();
  });

  it("withdraws its own declaration when the state is cleared", () => {
    const managed = new TestWindow();
    managed.setLayerShell(options);
    void managed.show();
    // A show event is not proof the native thread consumed the declaration.
    hoisted.cancelLayerShell.mockClear();

    expect(managed.setLayerShell(null)).toBe(true);

    expect(managed.layerShell).toBeNull();
    expect(hoisted.cancelLayerShell).toHaveBeenCalledWith(managed.id);
  });

  it("reports state it cannot send", () => {
    hoisted.validateLayerShell.mockReturnValue(false);
    const managed = new TestWindow();

    expect(managed.setLayerShell(options)).toBe(false);
    expect(hoisted.useLayerShell).not.toHaveBeenCalled();
  });

  it("clears the recorded state", () => {
    const managed = new TestWindow();
    managed.setLayerShell(options);

    expect(managed.setLayerShell(null)).toBe(true);

    expect(managed.layerShell).toBeNull();
  });

  it("refuses when the compositor has no layer shell", () => {
    hoisted.layerShellAvailable.mockReturnValue(false);
    const managed = new TestWindow();
    hoisted.useLayerShell.mockClear();

    expect(managed.setLayerShell(options)).toBe(false);
    expect(hoisted.useLayerShell).not.toHaveBeenCalled();
    expect(managed.layerShell).toEqual(options);
  });

  it("reports availability only on Wayland", () => {
    expect(ManagedWindow.isLayerShellAvailable()).toBe(true);

    hoisted.desktop.mockReturnValue(X11);

    expect(ManagedWindow.isLayerShellAvailable()).toBe(false);
  });
});

describe("ManagedWindow title", () => {
  it("owns the title and writes the managed id into it", () => {
    class TitledWindow extends ManagedWindow {
      constructor() {
        super();
        this.createBrowserWindow({ title: "Real Title" });
      }
    }

    const managed = new TitledWindow();
    const wnd = asFake(managed.window);

    // The initial native role must already carry the managed id.
    expect((wnd.options as { title?: string }).title).toBe(
      hoisted.decorateTitle(managed.id, "Real Title")
    );
    expect(managed.title).toBe("Real Title");
    expect(wnd.title).toBe(hoisted.decorateTitle(managed.id, "Real Title"));
  });

  it("writes the managed id again on every title change", () => {
    const managed = new TestWindow();
    const wnd = asFake(managed.window);

    managed.setTitle("From the app");

    expect(managed.title).toBe("From the app");
    expect(wnd.title).toBe(hoisted.decorateTitle(managed.id, "From the app"));
  });

  it("takes the page title instead of letting the page write it", () => {
    const managed = new TestWindow();
    const wnd = asFake(managed.window);
    const event = { preventDefault: vi.fn() };

    wnd.emit("page-title-updated", event, "From the page");

    expect(event.preventDefault).toHaveBeenCalled();
    expect(managed.title).toBe("From the page");
    expect(wnd.title).toBe(hoisted.decorateTitle(managed.id, "From the page"));
  });

  it("ignores its own write coming back from the page", () => {
    const managed = new TestWindow();
    const wnd = asFake(managed.window);
    managed.setTitle("Once");
    const written = wnd.title;
    const event = { preventDefault: vi.fn() };

    wnd.emit("page-title-updated", event, written);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(managed.title).toBe("Once");
    expect(wnd.title).toBe(written);
  });

  it("writes the bare title where nothing strips the id", () => {
    hoisted.desktop.mockReturnValue(X11);
    const managed = new TestWindow();

    managed.setTitle("Plain");

    expect(managed.title).toBe("Plain");
    expect(asFake(managed.window).title).toBe("Plain");
    expect(hoisted.decorateTitle).not.toHaveBeenCalled();
  });

  it("leaves the page title alone where nothing decorates it", () => {
    hoisted.desktop.mockReturnValue(X11);
    const managed = new TestWindow();
    const wnd = asFake(managed.window);
    managed.setTitle("From the app");
    const event = { preventDefault: vi.fn() };

    wnd.emit("page-title-updated", event, "From the page");

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(wnd.title).toBe("From the app");
  });

  it("finds a window by the id the native layer reports", () => {
    const managed = new TestWindow();

    expect(ManagedWindow.fromId(managed.id)).toBe(managed);
    expect(ManagedWindow.fromId("not-a-window")).toBeUndefined();
  });

  it("carries the title to a replacement window", () => {
    const managed = new TestWindow();
    managed.setTitle("Kept");
    const next = new TestWindow();

    managed.transferStateTo(next);

    expect(next.title).toBe("Kept");
    expect(asFake(next.window).title).toBe(hoisted.decorateTitle(next.id, "Kept"));
  });
});
