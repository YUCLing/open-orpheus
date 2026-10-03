import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class Window {
    id: string;
    destroyed = false;
    handlers = new Map<string, Array<() => void>>();
    webContents = {
      on: vi.fn(),
      off: vi.fn(),
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
    ipc: new Map<object, Record<string, (...args: any[]) => Promise<any>>>(),
    arm: vi.fn(() => 1 as number | null),
    cancel: vi.fn(),
    desktop: "wayland",
    overlays: [] as Window[],
    overlayOrder: [] as string[],
    capture: vi.fn(),
    cancelCapture: vi.fn(),
    enter: undefined as ((x: number, y: number) => void) | undefined,
    overlayPolicy: { platform: "kde", capturePhase: "before-create" },
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
  supportsNativeWaylandPopup: () => true,
  armNextWindowAsPopup: mocks.arm,
  cancelPendingPopup: mocks.cancel,
  isWindowWaylandPopup: () => true,
  captureWindowNextPointerAxis: () => 1,
  cancelWindowPointerAxisCapture: vi.fn(),
  captureNextWindowFirstCursorEnter: mocks.capture,
  cancelNextWindowFirstCursorEnter: mocks.cancelCapture,
  getCursorPosition: vi.fn(),
}));
vi.mock("../../src/main/menu/skin", () => ({ menuSkin: {}, registerMenuSkinUpdater: vi.fn() }));
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
  registerIpcHandlers: (contents: object, _name: string, handlers: any) => {
    mocks.ipc.set(contents, handlers);
  },
}));
vi.mock("../../src/bridge/common/inputRegion", () => ({ registerInputRegionHandlers: vi.fn() }));
vi.mock("../../src/main/pack", () => ({ default: {} }));
vi.mock("../../src/main/skin/dui", () => ({ parseBtnUrl: vi.fn(), parseElementTemplate: vi.fn() }));
vi.mock("../../src/main/gui", () => ({ font: "Sans" }));
vi.mock("../../src/main/logger", () => ({ default: { warn: vi.fn(), debug: vi.fn() } }));

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
    mocks.overlayPolicy.platform = platform;
    mocks.overlayPolicy.capturePhase = ["kde", "other"].includes(platform)
      ? "before-create"
      : "before-show";
    const menu = new AppMenu([]);
    try {
      await menu.show();
      const wnd = mocks.overlays[0];
      const data = await mocks.ipc.get(wnd.webContents)!.pull();
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
    mocks.overlayPolicy.platform = "gnome";
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
    mocks.overlayPolicy.platform = "kde";
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

describe("GNOME popup single-render opening", () => {
  let menu: AppMenu;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.arm.mockReturnValue(1);
    mocks.desktop = "wayland";
    mocks.roots.length = 0;
    mocks.children.length = 0;
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

  it("measures and maps the same root window exactly once", async () => {
    const { root, handlers } = await openRoot();
    expect(root.showInactive).not.toHaveBeenCalled();
    await handlers.reportSize(null, 232, 281);
    await handlers.reportSize(null, 233, 282);
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
    expect((await handlers.pull()).shadowInset).toBe(24);
  });

  it("maps each submenu without constructing a second renderer", async () => {
    const { root, handlers } = await openRoot();
    await handlers.reportSize(null, 232, 281);
    await handlers.openSubmenu(null, [], {}, 232, 40);
    const child = mocks.children[0];
    await mocks.ipc.get(child.webContents)!.reportSize(null, 120, 80);
    expect(mocks.children).toHaveLength(1);
    expect(child.destroyed).toBe(false);
    expect(child.showInactive).toHaveBeenCalledOnce();
    expect(mocks.arm).toHaveBeenLastCalledWith(root.id, child.id, 120, 80, 207, 16, 24);
    expect((await mocks.ipc.get(child.webContents)!.pull()).shadowInset).toBe(24);
  });

  it("does not add shadow margins to the Windows popup path", async () => {
    mocks.desktop = "windows";
    const { handlers } = await openRoot();
    expect((await handlers.pull()).shadowInset).toBeUndefined();
    await handlers.reportSize(null, 232, 281);
    await handlers.openSubmenu(null, [], {}, 232, 40);
    const child = mocks.children[0];
    expect((await mocks.ipc.get(child.webContents)!.pull()).shadowInset).toBeUndefined();
    expect(mocks.arm).not.toHaveBeenCalled();
  });

  it("ignores late reports from a closed root or replaced submenu", async () => {
    const { root, handlers } = await openRoot();
    await handlers.reportSize(null, 232, 281);
    await handlers.openSubmenu(null, [], {}, 232, 40);
    const old = mocks.children[0];
    await handlers.openSubmenu(null, [], {}, 232, 60);
    mocks.arm.mockClear();
    await mocks.ipc.get(old.webContents)!.reportSize(null, 120, 80);
    expect(old.destroyed).toBe(true);
    expect(mocks.arm).not.toHaveBeenCalled();
    menu.close();
    await handlers.reportSize(null, 232, 281);
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
    await handlers.reportSize(null, 232, 281);
    menu.close();
    mocks.arm.mockClear();
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.arm).not.toHaveBeenCalled();
    expect(root.showInactive).not.toHaveBeenCalled();
  });

  it.each(["wayland", "windows"])("cancels root and submenu blur timers on %s", async (desktop) => {
    mocks.desktop = desktop;
    const { root, handlers } = await openRoot();
    await handlers.reportSize(null, 232, 281);
    await handlers.openSubmenu(null, [], {}, 232, 40);
    const child = mocks.children[0];
    await mocks.ipc.get(child.webContents)!.reportSize(null, 120, 80);
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
