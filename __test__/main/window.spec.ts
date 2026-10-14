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
  const layerGeometryCallbacks: unknown[] = [];
  const layerPushedCallbacks: unknown[] = [];
  const layerOutputCallbacks: unknown[] = [];
  const appOnCalls: Array<[string, unknown]> = [];
  const whenReadyPromises: Promise<unknown>[] = [];

  return {
    platform: vi.fn(() => "linux" as NodeJS.Platform),
    desktop: vi.fn(() => 0),
    setInputRegion: vi.fn(() => true),
    setWindowLayerShell: vi.fn(() => true),
    setWindowLayerBounds: vi.fn(() => true),
    setWindowLayerSize: vi.fn(() => true),
    transferWindowState: vi.fn(() => true),
    forgetWindowState: vi.fn(() => true),
    showFailure: null as Error | null,
    validateLayerShell: vi.fn(() => true),
    layerShellRefusedCallbacks,
    onLayerShellRefused: vi.fn((callback: unknown) => {
      layerShellRefusedCallbacks.push(callback);
    }),
    layerGeometryCallbacks,
    onLayerSurfaceGeometry: vi.fn((callback: unknown) => {
      layerGeometryCallbacks.push(callback);
    }),
    layerPushedCallbacks,
    onLayerSurfacePushed: vi.fn((callback: unknown) => {
      layerPushedCallbacks.push(callback);
    }),
    layerOutputCallbacks,
    onLayerSurfaceOutput: vi.fn((callback: unknown) => {
      layerOutputCallbacks.push(callback);
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
    /** Layer-shell policy registrations made by the time a window was built. */
    policyCallsAtConstruction: [] as number[],
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
  setWindowLayerShell: hoisted.setWindowLayerShell,
  setWindowLayerBounds: hoisted.setWindowLayerBounds,
  setWindowLayerSize: hoisted.setWindowLayerSize,
  transferWindowState: hoisted.transferWindowState,
  forgetWindowState: hoisted.forgetWindowState,
  validateLayerShellOptions: hoisted.validateLayerShell,
  onLayerShellRoleRefused: hoisted.onLayerShellRefused,
  onLayerSurfaceGeometry: hoisted.onLayerSurfaceGeometry,
  onLayerSurfacePushed: hoisted.onLayerSurfacePushed,
  onLayerSurfaceOutput: hoisted.onLayerSurfaceOutput,
  decorateWindowTitle: hoisted.decorateTitle,
  drainWindowCallbacks: hoisted.drainWindowCallbacks,
  isLayerShellAvailable: hoisted.layerShellAvailable,
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
      hoisted.policyCallsAtConstruction.push(hoisted.setWindowLayerShell.mock.calls.length);
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

import { ManagedWindow, OnDemandWindow, switchWindowPolicy } from "../../src/main/window";
import { LayerShellLayer } from "@open-orpheus/window";
import type AppMenu from "../../src/main/menu";

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
  hoisted.setWindowLayerShell.mockReset();
  hoisted.setWindowLayerShell.mockReturnValue(true);
  hoisted.setWindowLayerBounds.mockReset();
  hoisted.setWindowLayerBounds.mockReturnValue(true);
  hoisted.setWindowLayerSize.mockReset();
  hoisted.setWindowLayerSize.mockReturnValue(true);
  hoisted.transferWindowState.mockReset();
  hoisted.transferWindowState.mockReturnValue(true);
  hoisted.forgetWindowState.mockReset();
  hoisted.forgetWindowState.mockReturnValue(true);
  hoisted.validateLayerShell.mockReset();
  hoisted.validateLayerShell.mockReturnValue(true);
  hoisted.decorateTitle.mockClear();
  hoisted.layerShellAvailable.mockReset();
  hoisted.layerShellAvailable.mockReturnValue(true);
  hoisted.policyCallsAtConstruction.length = 0;
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
      if (file.endsWith(join("main", "window.ts"))) continue;
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
  it("records the input region against the window id and lets the native layer own it", () => {
    const managed = new TestWindow();
    const wnd = asFake(managed.window);

    expect(managed.setWindowInputRegion(regions)).toBe(true);
    expect(hoisted.setInputRegion).toHaveBeenCalledTimes(1);
    expect(hoisted.setInputRegion).toHaveBeenLastCalledWith(managedId(wnd), [
      { x: 0, y: 0, w: 10, h: 10 },
    ]);

    // Wayland applies the recorded region when the id names a surface, so a
    // show does not re-send it.
    wnd.emit("show");

    expect(hoisted.setInputRegion).toHaveBeenCalledTimes(1);
  });

  it("clears the input region immediately when it was cleared explicitly", () => {
    const managed = new TestWindow();
    const wnd = asFake(managed.window);

    managed.setWindowInputRegion([]);
    wnd.emit("show");

    expect(hoisted.setInputRegion).toHaveBeenCalledTimes(1);
    expect(hoisted.setInputRegion).toHaveBeenLastCalledWith(managedId(wnd), null);
  });

  it("applies the input region once on X11, without a show re-send", () => {
    hoisted.desktop.mockReturnValue(X11);
    const managed = new TestWindow();
    const wnd = asFake(managed.window);

    expect(managed.setWindowInputRegion(regions)).toBe(true);
    expect(hoisted.setInputRegion).toHaveBeenCalledTimes(1);
    expect(hoisted.setInputRegion).toHaveBeenLastCalledWith(expect.any(Buffer), [
      { x: 0, y: 0, w: 10, h: 10 },
    ]);

    // The handle is valid by the time the renderer asks, so a show adds
    // nothing; a replacement page re-sends its own region on mount.
    wnd.emit("show");

    expect(hoisted.setInputRegion).toHaveBeenCalledTimes(1);
  });

  it("forwards the native result, which reports that the region was recorded", () => {
    hoisted.setInputRegion.mockReturnValue(false);
    const managed = new TestWindow();

    expect(managed.setWindowInputRegion(regions)).toBe(false);
  });

  it("reports the screen a layer surface lives on", () => {
    const managed = new TestWindow();
    const wnd = asFake(managed.window);

    // A layer surface cannot move to another output, so the native layer needs
    // the size of this one to keep a drag inside it.
    expect(managed.setLayerBounds(2560, 1440)).toBe(true);
    expect(hoisted.setWindowLayerBounds).toHaveBeenCalledExactlyOnceWith(
      managedId(wnd),
      2560,
      1440
    );
  });

  it("reports no screen where no layer surface can exist", () => {
    hoisted.desktop.mockReturnValue(X11);
    const managed = new TestWindow();

    expect(managed.setLayerBounds(2560, 1440)).toBe(false);
    expect(hoisted.setWindowLayerBounds).not.toHaveBeenCalled();
  });

  it("sizes a layer surface through the native layer", () => {
    const managed = new TestWindow();
    const wnd = asFake(managed.window);

    // A converted window cannot resize itself: the compositor keeps the size
    // its layer surface was given. Sub-pixel values are the caller's business.
    expect(managed.setLayerSize(640.4, 180.6)).toBe(true);
    expect(hoisted.setWindowLayerSize).toHaveBeenCalledExactlyOnceWith(managedId(wnd), 640, 181);
  });

  it("leaves resizing to the window where no layer surface can exist", () => {
    hoisted.desktop.mockReturnValue(X11);
    const managed = new TestWindow();

    expect(managed.setLayerSize(640, 180)).toBe(false);
    expect(hoisted.setWindowLayerSize).not.toHaveBeenCalled();
  });

  it("reports a size the native layer could not send", () => {
    hoisted.setWindowLayerSize.mockReturnValue(false);
    const managed = new TestWindow();

    expect(managed.setLayerSize(640, 180)).toBe(false);
  });
});

describe("OnDemandWindow recreation", () => {
  it("keeps the recorded input region across window recreation", async () => {
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
    // The wrapper keeps its id, so the native layer still holds the region and
    // applies it to the replacement surface; nothing is re-sent from here.
    expect(managed.window).not.toBeNull();
    expect(hoisted.setInputRegion).not.toHaveBeenCalled();
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

describe("ManagedWindow.moveNameTo only", () => {
  it("moves the name and nothing else", () => {
    // A window is looked up by name, and the lookup takes whichever wrapper
    // comes first — so the one being replaced has to stop answering to it, or
    // the next hide or show lands on a window that is already gone.
    const managed = new TestWindow();
    managed.setData("name", "desktop_lyrics");
    const next = new TestWindow();
    hoisted.transferWindowState.mockClear();

    managed.moveNameTo(next);

    expect(next.getData("name")).toBe("desktop_lyrics");
    expect(managed.getData("name")).toBe("");
    expect(ManagedWindow.fromName("desktop_lyrics")).toBe(next);
    // Its own native state is the replacement's to register: for a window
    // being placed on another screen, that placement is the point of
    // replacing it.
    expect(hoisted.transferWindowState).not.toHaveBeenCalled();
  });
});

describe("replacing a window under the same name", () => {
  it("does not hand on a name that has already been handed over", () => {
    // Two replacements of one window would otherwise leave the second
    // answering to nothing at all — and the first is then a window on screen
    // that the name does not lead to.
    const name = "handed-over-name";
    const first = new TestWindow();
    first.setData("name", name);
    const second = new TestWindow();
    const third = new TestWindow();

    first.moveNameTo(second);
    first.moveNameTo(third);

    expect(second.getData("name")).toBe(name);
    expect(third.getData("name")).toBeUndefined();
    expect(ManagedWindow.fromName(name)).toBe(second);
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

  it("re-keys the native state for the replacement", () => {
    const managed = new TestWindow();
    managed.setWindowInputRegion(regions);
    hoisted.transferWindowState.mockClear();

    const next = switchWindowPolicy(managed, () => new TestWindow());

    expect(hoisted.transferWindowState).toHaveBeenCalledWith(managed.id, next.id);
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

    const next = switchWindowPolicy(managed, () => new TestOnDemandWindow());
    const recreated = asFake(next.window);

    expect(previous.destroyed).toBe(true);
    expect(recreated).not.toBe(previous);
    expect(hoisted.transferWindowState).toHaveBeenCalledWith(managed.id, next.id);

    recreated.emit("ready-to-show");
    expect(recreated.isVisible()).toBe(true);
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

  it("registers the policy before the window is built", () => {
    class LayerWindow extends ManagedWindow {
      constructor() {
        super();
        this.setLayerShell(options);
        this.createBrowserWindow({});
      }
    }

    const managed = new LayerWindow();

    expect(managed.window).not.toBeNull();
    expect(hoisted.setWindowLayerShell).toHaveBeenCalledWith(managed.id, options);
    expect(hoisted.policyCallsAtConstruction.at(-1)).toBeGreaterThan(0);
  });

  it("registers immediately and does not depend on a show", () => {
    const managed = new TestWindow();
    hoisted.setWindowLayerShell.mockClear();

    expect(managed.setLayerShell(options)).toBe(true);
    expect(hoisted.setWindowLayerShell).toHaveBeenCalledWith(managed.id, options);

    // The native layer applies the policy when the surface takes its role, so
    // a show registers nothing extra.
    hoisted.setWindowLayerShell.mockClear();
    void managed.show();
    void managed.hide();

    expect(hoisted.setWindowLayerShell).not.toHaveBeenCalled();
  });

  it("withdraws the policy with null", () => {
    const managed = new TestWindow();
    managed.setLayerShell(options);
    hoisted.setWindowLayerShell.mockClear();

    expect(managed.setLayerShell(null)).toBe(true);

    expect(hoisted.setWindowLayerShell).toHaveBeenCalledWith(managed.id, null);
  });

  it("releases the native state of a wrapper that is discarded", () => {
    const managed = new TestWindow();
    hoisted.forgetWindowState.mockClear();

    managed.releaseNativeState();

    expect(hoisted.forgetWindowState).toHaveBeenCalledWith(managed.id);
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

  it("surfaces where the native layer left a moved window", async () => {
    // The listener is registered once the app is ready.
    await hoisted.whenReadyPromises.at(-1);
    const managed = new TestWindow();
    managed.setLayerShell(options);
    const reported = managed.once("layerGeometry");
    const reportGeometry = hoisted.layerGeometryCallbacks.at(-1) as (geometry: {
      windowId: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }) => void;
    expect(reportGeometry).toBeTypeOf("function");

    // The native layer replays the gesture, so it is the only thing that knows
    // where the surface ended up.
    reportGeometry({ windowId: managed.id, x: 120, y: 48, width: 640, height: 180 });

    const event = await reported;
    expect(event.name).toBe("layerGeometry");
    expect(event.data).toEqual({ x: 120, y: 48, width: 640, height: 180 });
  });

  it("surfaces a gesture that ran out of screen", async () => {
    await hoisted.whenReadyPromises.at(-1);
    const managed = new TestWindow();
    managed.setLayerShell(options);
    const pushed = managed.once("layerPushed");
    const reportPush = hoisted.layerPushedCallbacks.at(-1) as (
      windowId: string,
      edges: number
    ) => void;
    expect(reportPush).toBeTypeOf("function");

    // The window stopped at the edge because a layer surface cannot move to
    // another output, which is where the application takes over.
    reportPush(managed.id, 8);

    const event = await pushed;
    expect(event.name).toBe("layerPushed");
    expect(event.data).toEqual({ edges: 8 });
  });

  it("surfaces the screen a layer surface ended up on", async () => {
    await hoisted.whenReadyPromises.at(-1);
    const managed = new TestWindow();
    managed.setLayerShell(options);
    const reported = managed.once("layerOutput");
    const reportOutput = hoisted.layerOutputCallbacks.at(-1) as (
      windowId: string,
      output: string
    ) => void;
    expect(reportOutput).toBeTypeOf("function");

    // The compositor picked the output when it created the surface and never
    // says which: this is the one name the two halves share.
    reportOutput(managed.id, "DP-2");

    const event = await reported;
    expect(event.name).toBe("layerOutput");
    expect(event.data).toEqual({ output: "DP-2" });
  });

  it("registers once for an on-demand window's first surface", () => {
    class OnDemandLayerWindow extends TestOnDemandWindow {
      constructor() {
        super();
        this.setLayerShell(options);
      }
    }

    const managed = new OnDemandLayerWindow();
    expect(hoisted.setWindowLayerShell).toHaveBeenCalledWith(managed.id, options);

    hoisted.setWindowLayerShell.mockClear();
    void managed.show();
    // The window is created hidden and shown once it can be displayed.
    asFake(managed.window).emit("ready-to-show");

    // The policy was registered ahead of the surface; showing adds nothing.
    expect(hoisted.setWindowLayerShell).not.toHaveBeenCalled();
    expect(asFake(managed.window).isVisible()).toBe(true);
  });

  it("leaves an ordinary window's policy unregistered", () => {
    const layer = new TestWindow();
    layer.setLayerShell(options);
    hoisted.setWindowLayerShell.mockClear();

    const ordinary = new TestWindow();

    expect(ordinary.window).not.toBeNull();
    expect(hoisted.setWindowLayerShell).not.toHaveBeenCalled();
  });

  it("re-keys the policy for the replacement on a policy switch", () => {
    const managed = new TestWindow();
    managed.setLayerShell(options);
    hoisted.transferWindowState.mockClear();

    const next = switchWindowPolicy(managed, () => new TestWindow());

    expect(hoisted.transferWindowState).toHaveBeenCalledWith(managed.id, next.id);
  });

  it("reports options it cannot send but still registers them", () => {
    hoisted.validateLayerShell.mockReturnValue(false);
    const managed = new TestWindow();
    hoisted.setWindowLayerShell.mockClear();

    expect(managed.setLayerShell(options)).toBe(false);
    // The policy is registered so it can apply if the compositor later takes it.
    expect(hoisted.setWindowLayerShell).toHaveBeenCalledWith(managed.id, options);
  });

  it("refuses when the compositor has no layer shell", () => {
    hoisted.layerShellAvailable.mockReturnValue(false);
    const managed = new TestWindow();
    hoisted.setWindowLayerShell.mockClear();

    expect(managed.setLayerShell(options)).toBe(false);
    expect(hoisted.setWindowLayerShell).toHaveBeenCalledWith(managed.id, options);
  });

  it("does not touch native state off Wayland", () => {
    hoisted.desktop.mockReturnValue(X11);
    const managed = new TestWindow();

    expect(managed.setLayerShell(options)).toBe(false);
    expect(hoisted.setWindowLayerShell).not.toHaveBeenCalled();

    expect(managed.setLayerShell(null)).toBe(true);
    expect(hoisted.setWindowLayerShell).not.toHaveBeenCalled();
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
