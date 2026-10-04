import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuContract } from "../../src/bridge/contracts/menu-api";
import type { registerIpcHandlers } from "../../src/bridge/register";
import { installLoggerStub } from "../helpers/globals";
import type { IpcMainInvokeEvent } from "electron";

type MenuHandlers = Parameters<typeof registerIpcHandlers<MenuContract>>[2];
const ipcEvent = {} as IpcMainInvokeEvent;

const mocks = vi.hoisted(() => {
  class Window {
    id: string;
    destroyed = false;
    handlers = new Map<string, Array<() => void>>();
    webContents = {
      on: vi.fn(),
      off: vi.fn(),
      send: vi.fn(),
      isDestroyed: () => this.destroyed,
    };
    setSize = vi.fn();
    bounds = { x: 100, y: 100, width: 300, height: 400 };
    getBounds = () => this.bounds;
    setBounds = vi.fn((bounds: typeof this.bounds) => {
      this.bounds = bounds;
    });
    showInactive = vi.fn();
    focus = vi.fn();
    isDestroyed = () => this.destroyed;
    isFocused = () => false;
    constructor(id: string) {
      this.id = id;
    }
    on(event: string, callback: () => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), callback]);
    }
    once(event: string, callback: () => void) {
      this.on(event, callback);
    }
    off(event: string, callback: () => void) {
      this.handlers.set(
        event,
        (this.handlers.get(event) ?? []).filter((fn) => fn !== callback)
      );
    }
    emit(event: string) {
      for (const callback of this.handlers.get(event) ?? []) callback();
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      for (const callback of this.handlers.get("closed") ?? []) callback();
    }
  }
  return {
    Window,
    roots: [] as Window[],
    children: [] as Window[],
    ipc: new Map<object, MenuHandlers>(),
    arm: vi.fn(() => 1 as number | null),
    cancel: vi.fn(),
    supportsPopup: vi.fn(() => true),
    isPopup: vi.fn(() => true),
    desktop: "wayland",
    overlays: [] as Window[],
    overlayOrder: [] as string[],
    capture: vi.fn(),
    cancelCapture: vi.fn(),
    enter: undefined as ((x: number, y: number) => void) | undefined,
    overlayPolicy: { capturePhase: "before-create" },
    noFullscreen: true,
  };
});

vi.mock("electron", () => ({
  BrowserWindow: mocks.Window,
  screen: {
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  },
}));
vi.mock("@open-orpheus/window", () => ({
  DesktopEnvironment: { Wayland: "wayland", Windows: "windows" },
  getDesktopEnvironment: () => mocks.desktop,
  supportsNativeWaylandPopup: mocks.supportsPopup,
  armNextWindowAsPopup: mocks.arm,
  cancelPendingPopup: mocks.cancel,
  isWindowWaylandPopup: mocks.isPopup,
  captureWindowNextPointerAxis: () => 1,
  cancelWindowPointerAxisCapture: vi.fn(),
  captureNextWindowFirstCursorEnter: mocks.capture,
  cancelNextWindowFirstCursorEnter: mocks.cancelCapture,
  getCursorPosition: vi.fn(),
}));
vi.mock("../../src/main/menu/skin", () => ({ menuSkin: {}, registerMenuSkinUpdater: vi.fn() }));
vi.mock("../../src/main/menu/popup-support", () => ({
  initializeWaylandPopupSupport: () => Promise.resolve(mocks.supportsPopup()),
}));
vi.mock("../../src/main/window", () => ({
  ManagedWindow: { fromBrowserWindow: (wnd: { id: string }) => ({ id: wnd.id }) },
}));
vi.mock("../../src/main/menu/windows", () => ({
  createMenuWindow: vi.fn(() => {
    const wnd = new mocks.Window(`root-${mocks.roots.length}`);
    mocks.roots.push(wnd);
    return wnd;
  }),
  createSubmenuWindow: vi.fn(() => {
    const wnd = new mocks.Window(`child-${mocks.children.length}`);
    mocks.children.push(wnd);
    return wnd;
  }),
  getMenuWindow: () => mocks.roots.at(-1),
  getOverlayWindow: () => mocks.overlays.at(-1),
  destroyMenuWindow: () => mocks.roots.at(-1)?.destroy(),
  destroyOverlayWindow: () => mocks.overlays.at(-1)?.destroy(),
  createOverlayWindow: vi.fn(() => {
    mocks.overlayOrder.push("create");
    const wnd = new mocks.Window(`overlay-${mocks.overlays.length}`);
    Object.assign(wnd, {
      show: vi.fn(() => {
        mocks.overlayOrder.push("show");
        mocks.enter?.(1200, 700);
      }),
    });
    mocks.overlays.push(wnd);
    if (mocks.overlayPolicy.capturePhase === "before-create" || !mocks.noFullscreen)
      mocks.enter?.(1200, 700);
    return wnd;
  }),
}));
vi.mock("../../src/main/menu/workaround", () => ({
  overlayPolicy: mocks.overlayPolicy,
  WorkaroundFlags: { OverlayNoFullscreen: 1 },
  workaroundEnabled: () => mocks.noFullscreen,
}));
vi.mock("../../src/bridge/register", () => ({
  registerIpcHandlers: (contents: object, _name: string, handlers: MenuHandlers) => {
    mocks.ipc.set(contents, handlers);
  },
}));
vi.mock("../../src/bridge/common/inputRegion", () => ({ registerInputRegionHandlers: vi.fn() }));
vi.mock("../../src/main/pack", () => ({ default: {} }));
vi.mock("../../src/main/skin/dui", () => ({ parseBtnUrl: vi.fn(), parseElementTemplate: vi.fn() }));
vi.mock("../../src/main/gui", () => ({ font: "Sans" }));
const logger = installLoggerStub();

import AppMenu from "../../src/main/menu";

describe("overlay cursor capture ordering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.desktop = "wayland";
    mocks.overlays.length = 0;
    mocks.overlayOrder.length = 0;
    mocks.enter = undefined;
    mocks.noFullscreen = true;
    mocks.cancelCapture.mockClear();
    mocks.capture.mockImplementation((callback) => {
      mocks.overlayOrder.push("capture");
      mocks.enter = callback;
      return 77;
    });
  });
  afterEach(() => vi.useRealTimers());

  it.each(["kde", "other", "gnome", "niri"])("captures the first enter on %s", async (platform) => {
    mocks.overlayPolicy.capturePhase = ["kde", "other"].includes(platform)
      ? "before-create"
      : "before-show";
    const menu = new AppMenu([]);
    try {
      await menu.show();
      const wnd = mocks.overlays[0];
      const data = await mocks.ipc.get(wnd.webContents)!.pull(ipcEvent);
      expect([data.cursorX, data.cursorY]).toEqual([1200, 700]);
      expect(mocks.overlayOrder).toEqual(
        ["kde", "other"].includes(platform)
          ? ["capture", "create", "show"]
          : ["create", "capture", "show"]
      );
      expect(mocks.cancelCapture).toHaveBeenCalledWith(77);
    } finally {
      menu.close();
    }
  });

  it("arms before creation when fullscreen is forced on GNOME", async () => {
    mocks.overlayPolicy.capturePhase = "before-show";
    mocks.noFullscreen = false;
    const menu = new AppMenu([]);
    try {
      await menu.show();
      expect(mocks.overlayOrder).toEqual(["capture", "create"]);
    } finally {
      menu.close();
    }
  });

  it("cancels KDE capture when closed before renderer pull", async () => {
    mocks.overlayPolicy.capturePhase = "before-create";
    mocks.capture.mockImplementation(() => 88);
    const menu = new AppMenu([]);
    await menu.show();
    menu.close();
    expect(mocks.cancelCapture).toHaveBeenCalledExactlyOnceWith(88);
    vi.advanceTimersByTime(200);
    expect(mocks.cancelCapture).toHaveBeenCalledOnce();
  });
});

describe("Wayland popup single-render opening", () => {
  let menu: AppMenu;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.arm.mockReturnValue(1);
    mocks.supportsPopup.mockReturnValue(true);
    mocks.isPopup.mockReturnValue(true);
    mocks.desktop = "wayland";
    mocks.roots.length = 0;
    mocks.children.length = 0;
    mocks.overlays.length = 0;
    mocks.overlayOrder.length = 0;
    mocks.enter = undefined;
    mocks.overlayPolicy.capturePhase = "before-create";
    mocks.noFullscreen = false;
    mocks.capture.mockImplementation((callback) => {
      mocks.overlayOrder.push("capture");
      mocks.enter = callback;
      return 77;
    });
    mocks.ipc.clear();
    menu = new AppMenu([]);
  });
  afterEach(() => {
    menu.close();
    vi.useRealTimers();
  });

  async function openRoot() {
    await menu.show(new mocks.Window("parent") as never);
    const root = mocks.roots[0];
    const handlers = mocks.ipc.get(root.webContents)!;
    return { root, handlers };
  }

  it.each(["gnome", "niri", "kde", "other"])(
    "prefers the same native popup on %s",
    async (platform) => {
      mocks.overlayPolicy.capturePhase = ["kde", "other"].includes(platform)
        ? "before-create"
        : "before-show";
      const { root, handlers } = await openRoot();
      expect(root.showInactive).not.toHaveBeenCalled();
      expect((await handlers.pull(ipcEvent)).pendingPopup).toBe(true);
      expect(root.webContents.send).not.toHaveBeenCalled();
      await handlers.reportSize(ipcEvent, 232, 281);
      await handlers.reportSize(ipcEvent, 233, 282);
      expect(mocks.roots).toHaveLength(1);
      expect(root.destroyed).toBe(false);
      expect(root.setSize).toHaveBeenCalledExactlyOnceWith(232, 281);
      expect(root.showInactive).toHaveBeenCalledOnce();
      expect(mocks.arm).toHaveBeenCalledExactlyOnceWith(
        "parent",
        root.id,
        232,
        281,
        undefined,
        undefined,
        24
      );
      expect((await handlers.pull(ipcEvent)).shadowInset).toBe(24);
      expect(mocks.overlays).toHaveLength(0);
      expect(root.webContents.send).toHaveBeenCalledExactlyOnceWith("menu.popupReady");
      expect((await handlers.pull(ipcEvent)).pendingPopup).toBe(false);
    }
  );

  it("keeps unsupported Wayland sessions on the existing overlay path", async () => {
    mocks.supportsPopup.mockReturnValue(false);
    await menu.show(new mocks.Window("parent") as never);
    expect(mocks.roots).toHaveLength(0);
    expect(mocks.arm).not.toHaveBeenCalled();
    expect(mocks.overlays.at(-1)?.destroyed).toBe(false);
  });

  it("falls back to the existing overlay when the availability check throws", async () => {
    const error = new Error("native interface unavailable");
    mocks.supportsPopup.mockImplementationOnce(() => {
      throw error;
    });
    await menu.show(new mocks.Window("parent") as never);
    expect(mocks.roots).toHaveLength(0);
    expect(mocks.arm).not.toHaveBeenCalled();
    expect(mocks.overlays).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { err: error },
      "Wayland popup availability check failed"
    );
  });

  it.each(["kde", "gnome", "niri", "other"])(
    "keeps the %s overlay policy when popup data is unavailable",
    async (platform) => {
      mocks.overlayPolicy.capturePhase = ["kde", "other"].includes(platform)
        ? "before-create"
        : "before-show";
      mocks.noFullscreen = platform !== "kde";
      mocks.arm.mockReturnValue(null);
      const { root, handlers } = await openRoot();
      await handlers.reportSize(ipcEvent, 232, 281);
      await vi.advanceTimersByTimeAsync(200);
      expect(root.destroyed).toBe(true);
      expect(root.showInactive).not.toHaveBeenCalled();
      expect(mocks.cancel).not.toHaveBeenCalled();
      expect(mocks.overlays).toHaveLength(1);
      const overlay = mocks.overlays[0];
      const data = await mocks.ipc.get(overlay.webContents)!.pull(ipcEvent);
      expect([data.cursorX, data.cursorY]).toEqual([1200, 700]);
      expect(data.shadowInset).toBeUndefined();
      expect(mocks.overlayOrder).toEqual(
        ["kde", "other"].includes(platform)
          ? ["capture", "create", "show"]
          : ["create", "capture", "show"]
      );
      const attempts = mocks.arm.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mocks.arm).toHaveBeenCalledTimes(attempts);
      menu.close();
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it("falls back if a later popup data retry throws", async () => {
    const error = new Error("connection closed during retry");
    mocks.arm.mockReturnValueOnce(null).mockImplementationOnce(() => {
      throw error;
    });
    const { root, handlers } = await openRoot();
    await handlers.reportSize(ipcEvent, 232, 281);
    await vi.advanceTimersByTimeAsync(5);
    expect(root.destroyed).toBe(true);
    expect(root.showInactive).not.toHaveBeenCalled();
    expect(mocks.overlays).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { reason: "popup arming failed", err: error },
      "Wayland popup unavailable; falling back to overlay"
    );
  });

  it("logs the reason and releases the reservation when conversion times out", async () => {
    mocks.isPopup.mockReturnValue(false);
    const { root, handlers } = await openRoot();
    await handlers.reportSize(ipcEvent, 232, 281);
    await vi.advanceTimersByTimeAsync(200);
    expect(root.destroyed).toBe(true);
    expect(mocks.cancel).toHaveBeenCalledWith(1);
    expect(root.webContents.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { reason: "popup conversion timed out" },
      "Wayland popup unavailable; falling back to overlay"
    );
    menu.close();
    mocks.isPopup.mockReturnValue(true);
    menu = new AppMenu([]);
    await menu.show(new mocks.Window("parent") as never);
    const retry = mocks.roots[1];
    await mocks.ipc.get(retry.webContents)!.reportSize(ipcEvent, 232, 281);
    expect(retry.webContents.send).toHaveBeenCalledWith("menu.popupReady");
    expect(retry.destroyed).toBe(false);
  });

  it("does not reveal a closed popup when conversion finishes late", async () => {
    mocks.isPopup.mockReturnValue(false);
    const { root, handlers } = await openRoot();
    await handlers.reportSize(ipcEvent, 232, 281);
    await vi.advanceTimersByTimeAsync(50);
    menu.close();
    mocks.isPopup.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(root.webContents.send).not.toHaveBeenCalled();
    expect(mocks.overlays).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains the exception when popup initialization falls back", async () => {
    const { root, handlers } = await openRoot();
    const error = new Error("show failed");
    root.showInactive.mockImplementationOnce(() => {
      throw error;
    });
    await handlers.reportSize(ipcEvent, 232, 281);
    expect(root.destroyed).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      { reason: "popup show failed", err: error },
      "Wayland popup unavailable; falling back to overlay"
    );
  });

  it("reports rejected close listeners before releasing them", async () => {
    const error = new Error("close listener failed");
    menu.on("close", () => {
      throw error;
    });
    menu.close();
    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith(
        { err: expect.objectContaining({ errors: [error] }) },
        "Menu close listener failed"
      )
    );
  });

  it("maps each submenu without constructing a second renderer", async () => {
    const { root, handlers } = await openRoot();
    await handlers.reportSize(ipcEvent, 232, 281);
    await handlers.openSubmenu(ipcEvent, [], {}, 232, 40);
    const child = mocks.children[0];
    expect((await mocks.ipc.get(child.webContents)!.pull(ipcEvent)).pendingPopup).toBe(true);
    await mocks.ipc.get(child.webContents)!.reportSize(ipcEvent, 120, 80);
    expect(mocks.children).toHaveLength(1);
    expect(child.destroyed).toBe(false);
    expect(child.showInactive).toHaveBeenCalledOnce();
    expect(mocks.arm).toHaveBeenLastCalledWith(root.id, child.id, 120, 80, 207, 16, 24);
    expect((await mocks.ipc.get(child.webContents)!.pull(ipcEvent)).shadowInset).toBe(24);
    expect(child.webContents.send).toHaveBeenCalledExactlyOnceWith("menu.popupReady");
    expect((await mocks.ipc.get(child.webContents)!.pull(ipcEvent)).pendingPopup).toBe(false);
  });

  it.each(["windows", "x11", "macos"])(
    "does not use the native Wayland interface on %s",
    async (desktop) => {
      mocks.desktop = desktop;
      const { handlers } = await openRoot();
      expect((await handlers.pull(ipcEvent)).shadowInset).toBeUndefined();
      expect((await handlers.pull(ipcEvent)).pendingPopup).toBeUndefined();
      await handlers.reportSize(ipcEvent, 232, 281);
      await handlers.openSubmenu(ipcEvent, [], {}, 232, 40);
      const child = mocks.children[0];
      expect((await mocks.ipc.get(child.webContents)!.pull(ipcEvent)).shadowInset).toBeUndefined();
      expect(mocks.arm).not.toHaveBeenCalled();
      expect(mocks.supportsPopup).not.toHaveBeenCalled();
      expect(mocks.roots[0].webContents.send).not.toHaveBeenCalled();
    }
  );

  it("closes the native menu chain when the submenu requests close", async () => {
    const { root, handlers } = await openRoot();
    await handlers.reportSize(ipcEvent, 232, 281);
    await handlers.openSubmenu(ipcEvent, [], {}, 232, 40);
    const child = mocks.children[0];
    const childHandlers = mocks.ipc.get(child.webContents)!;
    await childHandlers.reportSize(ipcEvent, 120, 80);
    await childHandlers.close(ipcEvent);
    expect(child.destroyed).toBe(true);
    expect(root.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.overlays).toHaveLength(0);
  });

  it("ignores close requests from a replaced native submenu", async () => {
    const { root, handlers } = await openRoot();
    await handlers.reportSize(ipcEvent, 232, 281);
    await handlers.openSubmenu(ipcEvent, [], {}, 232, 40);
    const oldHandlers = mocks.ipc.get(mocks.children[0].webContents)!;
    await handlers.openSubmenu(ipcEvent, [], {}, 232, 60);
    await oldHandlers.close(ipcEvent);
    expect(root.destroyed).toBe(false);
    expect(mocks.children[1].destroyed).toBe(false);
  });

  it("ignores late reports from a closed root or replaced submenu", async () => {
    const { root, handlers } = await openRoot();
    await handlers.reportSize(ipcEvent, 232, 281);
    await handlers.openSubmenu(ipcEvent, [], {}, 232, 40);
    const old = mocks.children[0];
    await handlers.openSubmenu(ipcEvent, [], {}, 232, 60);
    mocks.arm.mockClear();
    await mocks.ipc.get(old.webContents)!.reportSize(ipcEvent, 120, 80);
    expect(old.destroyed).toBe(true);
    expect(mocks.arm).not.toHaveBeenCalled();
    menu.close();
    await handlers.reportSize(ipcEvent, 232, 281);
    expect(root.destroyed).toBe(true);
    expect(mocks.arm).not.toHaveBeenCalled();
  });

  it("times out a renderer that never reports its size", async () => {
    const { root } = await openRoot();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(root.destroyed).toBe(true);
    expect(mocks.arm).not.toHaveBeenCalled();
  });

  it("cancels parent-readiness retries when closed before mapping", async () => {
    mocks.arm.mockReturnValue(null);
    const { root, handlers } = await openRoot();
    await handlers.reportSize(ipcEvent, 232, 281);
    menu.close();
    mocks.arm.mockClear();
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.arm).not.toHaveBeenCalled();
    expect(root.showInactive).not.toHaveBeenCalled();
  });

  it.each(["wayland", "windows"])("cancels root and submenu blur timers on %s", async (desktop) => {
    mocks.desktop = desktop;
    const { root, handlers } = await openRoot();
    await handlers.reportSize(ipcEvent, 232, 281);
    await handlers.openSubmenu(ipcEvent, [], {}, 232, 40);
    const child = mocks.children[0];
    await mocks.ipc.get(child.webContents)!.reportSize(ipcEvent, 120, 80);
    root.emit("blur");
    child.emit("blur");
    expect(vi.getTimerCount()).toBe(2);
    menu.close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(root.destroyed).toBe(true);
    expect(child.destroyed).toBe(true);
  });
});
