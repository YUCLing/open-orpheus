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
  /** What the window was constructed with. */
  options: unknown;
}

const hoisted = vi.hoisted(() => ({
  platform: vi.fn(() => "linux" as NodeJS.Platform),
  desktop: vi.fn(() => 0),
  setInputRegion: vi.fn(() => true),
  useLayerShell: vi.fn(() => true),
  cancelLayerShell: vi.fn(() => true),
  validateLayerShell: vi.fn(() => true),
  onLayerShellRefused: vi.fn(),
  whenReady: vi.fn(() => Promise.resolve()),
  /** Stands in for the native decoration of a managed title. */
  decorateTitle: vi.fn((id: string, title: string) => `#${id}#${title}`),
  layerShellAvailable: vi.fn(() => true),
  /** Layer-shell declarations made by the time a window was constructed. */
  layerCallsAtConstruction: [] as number[],
  lifecycle: { state: 0 },
  appOn: vi.fn(),
}));

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
      FakeBrowserWindow.byId.set(this.id, this);
      hoisted.layerCallsAtConstruction.push(
        hoisted.useLayerShell.mock.calls.length
      );
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
      this.visible = true;
      this.emit("show");
    }
    showInactive() {
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

import {
  ManagedWindow,
  OnDemandWindow,
  switchWindowPolicy,
} from "../../src/main/window";
import { LayerShellLayer } from "@open-orpheus/window";

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

    expect(hoisted.setInputRegion).toHaveBeenLastCalledWith(
      managedId(wnd),
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

    expect(hoisted.setInputRegion).toHaveBeenLastCalledWith(
      managedId(replacement),
      [{ x: 0, y: 0, w: 10, h: 10 }]
    );
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
    expect(hoisted.setInputRegion).toHaveBeenLastCalledWith(
      managedId(recreated),
      [{ x: 0, y: 0, w: 10, h: 10 }]
    );
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
    expect(hoisted.useLayerShell).toHaveBeenCalledWith(options);
    expect(hoisted.layerCallsAtConstruction.at(-1)).toBeGreaterThan(0);
  });

  it("declares from the pre-create hook, without ordering requirements", () => {
    class HookWindow extends ManagedWindow {
      constructor() {
        super();
        this.createBrowserWindow({});
      }

      protected beforeSurfaceCreated(): void {
        this.setLayerShell(options);
      }
    }

    const managed = new HookWindow();

    expect(managed.window).not.toBeNull();
    expect(hoisted.useLayerShell).toHaveBeenCalledWith(options);
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

    managed.show();

    expect(hoisted.useLayerShell).toHaveBeenCalledWith(options);
  });

  it("arms once per surface, not once per show", () => {
    const managed = new TestWindow();
    managed.setLayerShell(options);
    hoisted.useLayerShell.mockClear();

    managed.show();
    managed.show();

    expect(hoisted.useLayerShell).toHaveBeenCalledTimes(1);
  });

  it("arms again after a hide, which takes the surface away", () => {
    const managed = new TestWindow();
    managed.setLayerShell(options);
    managed.show();
    managed.hide();
    hoisted.useLayerShell.mockClear();

    managed.show();

    expect(hoisted.useLayerShell).toHaveBeenCalledWith(options);
  });

  it("arms when another module shows the window directly", () => {
    const managed = new TestWindow();
    managed.setLayerShell(options);
    hoisted.useLayerShell.mockClear();

    // `menu.ts`, the `winhelper.*` calls and `app.ts` show the raw window.
    asFake(managed.window).show();

    expect(hoisted.useLayerShell).toHaveBeenCalledWith(options);
  });

  it("arms when another module shows the window without focus", () => {
    const managed = new TestWindow();
    managed.setLayerShell(options);
    hoisted.useLayerShell.mockClear();

    asFake(managed.window).showInactive();

    expect(hoisted.useLayerShell).toHaveBeenCalledWith(options);
  });

  it("surfaces a refused layer-shell role for its window", async () => {
    // The listener is registered once the app is ready.
    await hoisted.whenReady.mock.results.at(-1)?.value;
    const managed = new TestWindow();
    managed.setLayerShell(options);
    const refused = managed.once("layerShellRefused");
    const reportRoleRefused = hoisted.onLayerShellRefused.mock.calls.at(
      -1
    )?.[0] as (windowId: string) => void;
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

    expect(
      hoisted.useLayerShell,
      "a hidden window has no surface yet"
    ).not.toHaveBeenCalled();

    managed.show();

    expect(hoisted.useLayerShell).toHaveBeenCalledWith(options);
  });

  it("arms for an on-demand window's first show", () => {
    class OnDemandLayerWindow extends TestOnDemandWindow {
      protected beforeSurfaceCreated(): void {
        this.setLayerShell(options);
      }
    }

    const managed = new OnDemandLayerWindow();
    hoisted.useLayerShell.mockClear();

    void managed.show();
    // The window is created hidden and shown once it can be displayed.
    asFake(managed.window).emit("ready-to-show");

    expect(hoisted.useLayerShell).toHaveBeenCalledWith(options);
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
    managed.show();
    // The surface exists, so nothing is in flight any more.
    hoisted.cancelLayerShell.mockClear();

    expect(managed.setLayerShell(null)).toBe(true);

    expect(managed.layerShell).toBeNull();
    expect(hoisted.cancelLayerShell).not.toHaveBeenCalled();
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

    // The title never reaches the constructor: only this module writes it.
    expect((wnd.options as { title?: string }).title).toBeUndefined();
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
    expect(asFake(next.window).title).toBe(
      hoisted.decorateTitle(next.id, "Kept")
    );
  });
});
