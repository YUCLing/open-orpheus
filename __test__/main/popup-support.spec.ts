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
    quitting: new Set<() => void>(),
    state: 0,
  };
});

vi.mock("@open-orpheus/window", () => ({
  DesktopEnvironment: { Wayland: "wayland" },
  getDesktopEnvironment: () => mocks.desktop,
  supportsNativeWaylandPopup: mocks.supports,
  armNextWindowAsPopup: mocks.arm,
  cancelPendingPopup: mocks.cancel,
  isWindowWaylandPopup: mocks.isPopup,
}));
vi.mock("../../src/main/window", () => ({
  ManagedWindow: { fromBrowserWindow: (window: { id: string }) => ({ id: window.id }) },
}));
vi.mock("../../src/main/menu/windows", () => ({
  createPopupProbeWindow: () => {
    const window = new mocks.Window(`probe-${mocks.windows.length}`);
    mocks.windows.push(window);
    return window;
  },
}));
vi.mock("../../src/main/lifecycle", () => ({
  LifecycleState: { Quitting: 4 },
  get state() {
    return mocks.state;
  },
  events: {
    on: (_event: string, callback: () => void) => {
      mocks.quitting.add(callback);
      return () => mocks.quitting.delete(callback);
    },
  },
}));

installLoggerStub();

describe("session-native popup support", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    mocks.windows.length = 0;
    mocks.quitting.clear();
    mocks.supports.mockReturnValue(true);
    mocks.arm.mockReturnValue(1);
    mocks.isPopup.mockReturnValue(true);
    mocks.desktop = "wayland";
    mocks.state = 0;
  });
  afterEach(() => vi.useRealTimers());

  const parent = () => new mocks.Window("parent") as unknown as BrowserWindow;

  it("probes once with an explicit anchor and cleans up before caching success", async () => {
    const { initializeWaylandPopupSupport } = await import("../../src/main/menu/popup-support");
    const window = parent();
    expect(await initializeWaylandPopupSupport(window)).toBe(true);
    expect(await initializeWaylandPopupSupport(window)).toBe(true);
    expect(mocks.windows).toHaveLength(1);
    expect(mocks.windows[0].destroyed).toBe(true);
    expect(mocks.arm).toHaveBeenCalledExactlyOnceWith("parent", "probe-0", 1, 1, 0, 0, 0);
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(1);
    expect(mocks.quitting.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caches a conversion timeout so later clicks use overlay immediately", async () => {
    mocks.isPopup.mockReturnValue(false);
    const { initializeWaylandPopupSupport } = await import("../../src/main/menu/popup-support");
    const window = parent();
    const probing = initializeWaylandPopupSupport(window);
    await vi.advanceTimersByTimeAsync(200);
    expect(await probing).toBe(false);
    mocks.isPopup.mockReturnValue(true);
    expect(await initializeWaylandPopupSupport(window)).toBe(false);
    expect(mocks.windows).toHaveLength(1);
    expect(mocks.windows[0].destroyed).toBe(true);
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares an in-flight startup probe with an early menu click", async () => {
    mocks.isPopup.mockReturnValue(false);
    const { initializeWaylandPopupSupport } = await import("../../src/main/menu/popup-support");
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
    const { initializeWaylandPopupSupport } = await import("../../src/main/menu/popup-support");
    expect(await initializeWaylandPopupSupport(parent())).toBe(false);
    expect(mocks.supports).not.toHaveBeenCalled();
    expect(mocks.windows).toHaveLength(0);
  });

  it("does not create a probe when hooks are disabled", async () => {
    mocks.supports.mockReturnValue(false);
    const { initializeWaylandPopupSupport } = await import("../../src/main/menu/popup-support");
    expect(await initializeWaylandPopupSupport(parent())).toBe(false);
    expect(mocks.windows).toHaveLength(0);
    expect(mocks.arm).not.toHaveBeenCalled();
  });

  it("cancels on parent close without caching a false incompatibility", async () => {
    mocks.arm.mockReturnValue(null);
    const { initializeWaylandPopupSupport } = await import("../../src/main/menu/popup-support");
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
    const { initializeWaylandPopupSupport } = await import("../../src/main/menu/popup-support");
    const probing = initializeWaylandPopupSupport(parent());
    mocks.state = 4;
    for (const cancel of mocks.quitting) cancel();
    expect(await probing).toBe(false);
    await vi.advanceTimersByTimeAsync(5);
    expect(mocks.windows[0].destroyed).toBe(true);
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(1);
    expect(mocks.quitting.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(await initializeWaylandPopupSupport(parent())).toBe(false);
    expect(mocks.windows).toHaveLength(1);
  });

  it("caches an arming timeout instead of probing again on subsequent clicks", async () => {
    mocks.arm.mockReturnValue(null);
    const { initializeWaylandPopupSupport } = await import("../../src/main/menu/popup-support");
    const probing = initializeWaylandPopupSupport(parent());
    await vi.advanceTimersByTimeAsync(200);
    expect(await probing).toBe(false);
    expect(mocks.windows[0].showInactive).not.toHaveBeenCalled();
    expect(mocks.windows[0].destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    mocks.arm.mockReturnValue(1);
    expect(await initializeWaylandPopupSupport(parent())).toBe(false);
    expect(mocks.windows).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not cache a transient native availability error", async () => {
    mocks.supports.mockImplementationOnce(() => {
      throw new Error("native interface not ready");
    });
    const { initializeWaylandPopupSupport } = await import("../../src/main/menu/popup-support");
    expect(await initializeWaylandPopupSupport(parent())).toBe(false);
    expect(await initializeWaylandPopupSupport(parent())).toBe(true);
    expect(mocks.windows).toHaveLength(1);
  });
});
