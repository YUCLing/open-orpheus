import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLoggerStub } from "../helpers/globals";

const mocks = vi.hoisted(() => {
  class Window {
    destroyed = false;
    handlers = new Map<string, Set<() => void>>();
    showInactive = vi.fn();
    constructor(readonly id: string) {}
    isDestroyed() {
      return this.destroyed;
    }
    once(event: string, callback: () => void) {
      const wrapped = () => {
        this.off(event, wrapped);
        callback();
      };
      // Keep the original callback removable, like the EventEmitter API.
      Object.assign(wrapped, { listener: callback });
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event)!.add(wrapped);
    }
    off(event: string, callback: () => void) {
      const listeners = this.handlers.get(event);
      for (const listener of listeners ?? []) {
        if (listener === callback || Reflect.get(listener, "listener") === callback) {
          listeners?.delete(listener);
        }
      }
    }
    destroy() {
      this.destroyed = true;
      for (const listener of this.handlers.get("closed") ?? []) listener();
    }
  }
  return {
    Window,
    windows: [] as Window[],
    supports: vi.fn(() => true),
    desktop: "wayland",
    arm: vi.fn(() => 1 as number | null),
    cancel: vi.fn(),
    isPopup: vi.fn(() => true),
  };
});

vi.mock("electron", () => ({
  app: { on: vi.fn(), whenReady: vi.fn(() => Promise.resolve()) },
  BrowserWindow: class {},
}));
vi.mock("@open-orpheus/window", () => ({
  DesktopEnvironment: { Wayland: "wayland" },
  getDesktopEnvironment: () => mocks.desktop,
  supportsNativeWaylandPopup: mocks.supports,
  armNextWindowAsPopup: mocks.arm,
  cancelPendingPopup: mocks.cancel,
  isWindowWaylandPopup: mocks.isPopup,
  drainWindowCallbacks: vi.fn(),
  isLayerShellAvailable: () => false,
  onLayerShellRoleRefused: vi.fn(),
  setInputRegion: vi.fn(),
  useLayerShellForNextWindow: vi.fn(),
  validateLayerShellOptions: () => true,
}));
installLoggerStub();

/**
 * The lifecycle state is reached through installed accessors rather than a
 * module the spec replaces. Importing a fresh copy per test and installing a
 * service is the seam the refactor provides (the accessors answer `Starting`
 * before `bootstrap()` runs, which is why they are module-level at all).
 */
let lifecycle: typeof import("@main/services/lifecycle");

function createProbeWindow() {
  const window = new mocks.Window(`probe-${mocks.windows.length}`);
  mocks.windows.push(window);
  return window as unknown as BrowserWindow;
}
function lookupManagedWindow(wnd: BrowserWindow) {
  return { id: (wnd as unknown as { id: string }).id } as never;
}

async function loadPopupSupport() {
  // `vi.resetModules()` gives this a fresh state of `Starting`, which is the
  // module's real initial value — nothing to install or reset.
  lifecycle = await import("@main/services/lifecycle");
  const mod = await import("@main/windows/menu/popup-support");
  return {
    initializeWaylandPopupSupport: (parent: BrowserWindow) =>
      mod.initializeWaylandPopupSupport(parent, { createProbeWindow, lookupManagedWindow }),
  };
}

describe("session-native popup support", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    mocks.windows.length = 0;
    mocks.supports.mockReturnValue(true);
    mocks.arm.mockReturnValue(1);
    mocks.isPopup.mockReturnValue(true);
    mocks.desktop = "wayland";
  });
  afterEach(() => vi.useRealTimers());

  const parent = () => new mocks.Window("parent") as unknown as BrowserWindow;

  it("probes once with an explicit anchor and cleans up before caching success", async () => {
    const { initializeWaylandPopupSupport } = await loadPopupSupport();
    const listenersBefore = lifecycle.events.listenerCount("quitting");
    const window = parent();
    expect(await initializeWaylandPopupSupport(window)).toBe(true);
    expect(await initializeWaylandPopupSupport(window)).toBe(true);
    expect(mocks.windows).toHaveLength(1);
    expect(mocks.windows[0].destroyed).toBe(true);
    expect(mocks.arm).toHaveBeenCalledExactlyOnceWith("parent", "probe-0", 1, 1, 0, 0, 0);
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(1);
    expect(lifecycle.events.listenerCount("quitting")).toBe(listenersBefore);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries an inconclusive conversion on the next menu click", async () => {
    mocks.isPopup.mockReturnValue(false);
    const { initializeWaylandPopupSupport } = await loadPopupSupport();
    const window = parent();
    const probing = initializeWaylandPopupSupport(window);
    await vi.advanceTimersByTimeAsync(200);
    expect(await probing).toBe(false);
    mocks.isPopup.mockReturnValue(true);
    expect(await initializeWaylandPopupSupport(window)).toBe(true);
    expect(mocks.windows).toHaveLength(2);
    expect(mocks.windows[0].destroyed).toBe(true);
    expect(mocks.cancel).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares an in-flight startup probe with an early menu click", async () => {
    mocks.isPopup.mockReturnValue(false);
    const { initializeWaylandPopupSupport } = await loadPopupSupport();
    const window = parent();
    const startup = initializeWaylandPopupSupport(window);
    const menu = initializeWaylandPopupSupport(window);
    expect(mocks.windows).toHaveLength(1);
    mocks.isPopup.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(5);
    expect(await startup).toBe(true);
    expect(await menu).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["windows", "x11", "macos"])("does not probe on %s", async (desktop) => {
    mocks.desktop = desktop;
    const { initializeWaylandPopupSupport } = await loadPopupSupport();
    expect(await initializeWaylandPopupSupport(parent())).toBe(false);
    expect(mocks.supports).not.toHaveBeenCalled();
    expect(mocks.windows).toHaveLength(0);
  });

  it("does not create a probe when hooks are disabled", async () => {
    mocks.supports.mockReturnValue(false);
    const { initializeWaylandPopupSupport } = await loadPopupSupport();
    expect(await initializeWaylandPopupSupport(parent())).toBe(false);
    expect(mocks.windows).toHaveLength(0);
    expect(mocks.arm).not.toHaveBeenCalled();
  });

  it("cancels on parent close without caching a false incompatibility", async () => {
    mocks.arm.mockReturnValue(null);
    const { initializeWaylandPopupSupport } = await loadPopupSupport();
    const window = new mocks.Window("parent");
    const probing = initializeWaylandPopupSupport(window as unknown as BrowserWindow);
    window.destroy();
    expect(await probing).toBe(false);
    expect(mocks.windows[0].destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    mocks.arm.mockReturnValue(1);
    expect(await initializeWaylandPopupSupport(parent())).toBe(true);
    expect(mocks.windows).toHaveLength(2);
  });

  it("cancels and releases the probe on application shutdown", async () => {
    mocks.isPopup.mockReturnValue(false);
    const { initializeWaylandPopupSupport } = await loadPopupSupport();
    const listenersBefore = lifecycle.events.listenerCount("quitting");
    const probing = initializeWaylandPopupSupport(parent());
    lifecycle.setLifecycleState(lifecycle.LifecycleState.Quitting);
    await lifecycle.events.emit("quitting");
    expect(await probing).toBe(false);
    await vi.advanceTimersByTimeAsync(5);
    expect(mocks.windows[0].destroyed).toBe(true);
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(1);
    expect(lifecycle.events.listenerCount("quitting")).toBe(listenersBefore);
    expect(vi.getTimerCount()).toBe(0);
    expect(await initializeWaylandPopupSupport(parent())).toBe(false);
    expect(mocks.windows).toHaveLength(1);
  });

  it("retries missing popup data after the parent becomes ready", async () => {
    mocks.arm.mockReturnValue(null);
    const { initializeWaylandPopupSupport } = await loadPopupSupport();
    const probing = initializeWaylandPopupSupport(parent());
    await vi.advanceTimersByTimeAsync(200);
    expect(await probing).toBe(false);
    expect(mocks.windows[0].showInactive).not.toHaveBeenCalled();
    expect(mocks.windows[0].destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    mocks.arm.mockReturnValue(1);
    expect(await initializeWaylandPopupSupport(parent())).toBe(true);
    expect(mocks.windows).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not cache a transient native availability error", async () => {
    mocks.supports.mockImplementationOnce(() => {
      throw new Error("native interface not ready");
    });
    const { initializeWaylandPopupSupport } = await loadPopupSupport();
    expect(await initializeWaylandPopupSupport(parent())).toBe(false);
    expect(await initializeWaylandPopupSupport(parent())).toBe(true);
    expect(mocks.windows).toHaveLength(1);
  });
});
