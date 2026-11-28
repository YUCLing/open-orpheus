import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class BaseWindow {
    static instances: BaseWindow[] = [];
    static pendingLoad: Promise<void> | null = null;
    contentView = { addChildView: vi.fn() };
    handlers = new Map<string, Array<() => void>>();
    destroyed = false;
    constructor(public options: Record<string, unknown>) {
      BaseWindow.instances.push(this);
    }
    setTitle = vi.fn();
    loadURL = vi.fn(() => BaseWindow.pendingLoad ?? Promise.resolve());
    show = vi.fn();
    showInactive = vi.fn();
    maximize = vi.fn();
    setSize = vi.fn();
    focus = vi.fn();
    setPosition = vi.fn();
    setIgnoreMouseEvents = vi.fn();
    isDestroyed = () => this.destroyed;
    getContentSize = () => [232, 281] as [number, number];
    getBounds = () => ({ x: 0, y: 0, width: 232, height: 281 });
    isVisible = () => true;
    isFocused = () => true;
    on(event: string, callback: () => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), callback]);
    }
    destroy() {
      this.destroyed = true;
      for (const callback of this.handlers.get("closed") ?? []) callback();
    }
  }

  class WebContentsView {
    static instances: WebContentsView[] = [];
    handlers = new Map<string, (...args: unknown[]) => unknown>();
    sent: Array<{ channel: string; payload: unknown }> = [];
    webContents = {
      ipc: {
        handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
          this.handlers.set(channel, handler);
        },
      },
      send: (channel: string, payload: unknown) => {
        this.sent.push({ channel, payload });
      },
      loadURL: vi.fn(async () => undefined),
      isDestroyed: () => false,
      close: vi.fn(),
      focus: vi.fn(),
      invalidate: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
    };
    setBounds = vi.fn();
    getBounds = () => ({ x: 0, y: 0, width: 232, height: 281 });
    setBackgroundColor = vi.fn();
    constructor() {
      WebContentsView.instances.push(this);
    }
  }

  class BaseWindowManagedWindow {
    static nextId = 1;
    static instances: BaseWindowManagedWindow[] = [];
    readonly id = String(BaseWindowManagedWindow.nextId++);
    window: InstanceType<typeof BaseWindow> | null = null;
    constructor() {
      BaseWindowManagedWindow.instances.push(this);
    }
    attach(window: InstanceType<typeof BaseWindow>) {
      this.window = window;
    }
    setTitle = vi.fn();
    setLayerShell = vi.fn((_options: Record<string, unknown>) => true);
    setLayerShellSize = vi.fn((_width: number, _height: number) => true);
    destroy = () => {
      this.window?.destroy();
    };
    releaseNativeState = vi.fn();
    setWindowInputRegion = vi.fn(() => true);
  }

  class LayerCaptureWindow {
    static nextId = 1;
    readonly id = `capture-${LayerCaptureWindow.nextId++}`;
    readonly window: InstanceType<typeof BaseWindow>;
    constructor(options: Record<string, unknown>) {
      this.window = new BaseWindow(options);
    }
    setTitle = vi.fn();
    releaseNativeState = vi.fn();
  }

  return {
    BaseWindow,
    BaseWindowManagedWindow,
    LayerCaptureWindow,
    WebContentsView,
    parentWindow: {
      isDestroyed: () => false,
      isFocused: () => true,
      on: vi.fn(),
      off: vi.fn(),
      once: vi.fn(),
      webContents: {
        on: vi.fn(),
        off: vi.fn(),
        isDestroyed: () => false,
      },
    },
    latestPress: null as {
      windowId: string;
      x: number;
      y: number;
      touch: boolean;
      ageMs: number;
    } | null,
    desktop: "wayland" as "wayland" | "x11",
    layerVersion: null as number | null,
    pointer: null as [number, number] | null,
    keyboardFocus: false,
    policy: vi.fn(() => true),
  };
});

vi.mock("electron", () => ({
  BaseWindow: mocks.BaseWindow,
  BrowserWindow: mocks.BaseWindow,
  WebContentsView: mocks.WebContentsView,
  screen: {
    getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    getDisplayNearestPoint: () => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    }),
    getAllDisplays: () => [
      {
        id: 7,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      },
    ],
    screenToDipPoint: (point: { x: number; y: number }) => point,
  },
}));

vi.mock("@open-orpheus/window", () => ({
  DesktopEnvironment: { Wayland: "wayland", X11: "x11", Windows: "windows" },
  LayerShellLayer: { Overlay: 3 },
  getDesktopEnvironment: () => mocks.desktop,
  supportsNativeWaylandPopup: () => true,
  getPopupCapability: () => ({ supported: true }),
  isWindowActivated: () => true,
  isWindowWaylandPopup: () => true,
  getPointerPosition: () => null,
  isWindowPointerInside: () => true,
  latestWindowPress: () => mocks.latestPress,
  setWindowPopupPolicy: mocks.policy,
  clearWindowPopupPolicy: vi.fn(() => true),
  decorateWindowTitle: (id: string, title: string) => `${id}:${title}`,
  forgetWindowState: vi.fn(),
  setInputRegion: vi.fn(() => true),
  getCursorPosition: () => null,
  captureNextWindowFirstCursorEnter: vi.fn(() => 1),
  cancelNextWindowFirstCursorEnter: vi.fn(() => true),
  captureCursorEnter: vi.fn(async () => mocks.pointer),
  getWindowOutputDisplayId: vi.fn(() => 7),
  isWindowKeyboardFocused: vi.fn(() => mocks.keyboardFocus),
  setWindowLayerShellSize: vi.fn(() => true),
  captureWindowTouch: vi.fn(() => 1),
  cancelWindowTouch: vi.fn(() => true),
}));

vi.mock("../../src/main/window", () => ({
  ManagedWindow: {
    fromBrowserWindow: () => ({ id: "parent-1" }),
    fromId: () => ({ window: mocks.parentWindow }),
    layerShellVersion: () => mocks.layerVersion,
  },
  BaseWindowManagedWindow: mocks.BaseWindowManagedWindow,
  LayerCaptureWindow: mocks.LayerCaptureWindow,
  guiUrl: (route: string) => route,
}));

vi.mock("../../src/main/gui", () => ({ font: "Sans" }));
vi.mock("../../src/main/menu/skin", () => ({
  menuSkin: {
    background: "#000",
    foreground: "#fff",
    foregroundDisabled: "#888",
    separator: "#333",
    itemHover: "#222",
  },
  registerMenuSkinUpdater: vi.fn(),
}));
vi.mock("../../src/main/pack", () => ({ default: {} }));
vi.mock("../../src/main/skin/dui", () => ({
  parseBtnUrl: vi.fn(() => null),
  parseElementTemplate: vi.fn(() => null),
}));

import AppMenu from "../../src/main/menu";
import type { AppMenuItem } from "@shared/types/menu";

function item(menuId: string, children: AppMenuItem[] | null = null): AppMenuItem {
  return {
    text: menuId,
    menu: false,
    enable: true,
    separator: false,
    children,
    image_color: "",
    menu_id: menuId,
  };
}

async function waitForView() {
  await vi.waitFor(() => expect(mocks.WebContentsView.instances.length).toBeGreaterThan(0));
  return mocks.WebContentsView.instances[0]!;
}

async function driveSurface(view: InstanceType<typeof mocks.WebContentsView>) {
  await vi.waitFor(() => expect(view.handlers.has("menu.surface.ready")).toBe(true));
  await view.handlers.get("menu.surface.ready")!({});
  await vi.waitFor(() =>
    expect(view.sent.some((entry) => entry.channel === "menu.surface.prepare")).toBe(true)
  );
  const prepare = view.sent.find((entry) => entry.channel === "menu.surface.prepare")!.payload as {
    requestId: number;
  };
  await view.handlers.get("menu.surface.reportSize")!(
    {},
    { requestId: prepare.requestId, width: 232, height: 281 }
  );
  await vi.waitFor(() =>
    expect(view.sent.some((entry) => entry.channel === "menu.surface.show")).toBe(true)
  );
  await view.handlers.get("menu.surface.visible")!({}, { requestId: prepare.requestId });
}

describe("new menu controller", () => {
  beforeEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    mocks.BaseWindow.instances.length = 0;
    mocks.BaseWindow.pendingLoad = null;
    mocks.WebContentsView.instances.length = 0;
    mocks.BaseWindowManagedWindow.nextId = 1;
    mocks.policy.mockClear();
    mocks.desktop = "wayland";
    mocks.latestPress = null;
    mocks.layerVersion = null;
    mocks.pointer = null;
    mocks.keyboardFocus = false;
    mocks.BaseWindowManagedWindow.instances.length = 0;
  });

  it("opens a native popup using the available anchor and resolves visible", async () => {
    mocks.latestPress = {
      windowId: "parent-1",
      x: 12,
      y: 34,
      touch: false,
      ageMs: 0,
    };
    const menu = new AppMenu([item("play")]);
    const showing = menu.show(mocks.parentWindow as never);
    const view = await waitForView();
    await driveSurface(view).catch((error) => console.error("drive failed", error));
    await showing.catch((error) => console.error("show failed", error));

    const prepared = view.sent.find((message) => message.channel === "menu.surface.prepare")!
      .payload as { id: string };
    expect(mocks.policy).toHaveBeenCalledWith(
      prepared.id,
      "parent-1",
      232,
      281,
      12,
      34,
      24,
      undefined
    );
    expect(mocks.BaseWindow.instances).toHaveLength(1);
    expect(mocks.BaseWindow.instances[0].options).toMatchObject({ width: 232, height: 281 });
    expect(mocks.BaseWindow.instances[0].show).toHaveBeenCalled();
    menu.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.BaseWindow.instances[0].destroyed).toBe(true);
  });

  it("falls back to overlay when no anchor is available", async () => {
    const menu = new AppMenu([item("play")]);
    const showing = menu.show(mocks.parentWindow as never);
    const view = await waitForView();
    await view.handlers.get("menu.surface.ready")!({});
    await vi.waitFor(() =>
      expect(view.sent.some((entry) => entry.channel === "menu.surface.prepare")).toBe(true)
    );
    expect(mocks.policy).not.toHaveBeenCalled();

    await vi.waitFor(() =>
      expect(view.sent.some((entry) => entry.channel === "menu.surface.show")).toBe(true)
    );
    const prepare = view.sent.find((entry) => entry.channel === "menu.surface.prepare")!
      .payload as { requestId: number };
    await view.handlers.get("menu.surface.visible")!({}, { requestId: prepare.requestId });
    await showing;
    menu.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("opens the desktop backend outside Wayland", async () => {
    mocks.desktop = "x11";
    const menu = new AppMenu([item("play")]);
    const showing = menu.show(mocks.parentWindow as never);
    const view = await waitForView();
    await driveSurface(view);
    await showing;

    expect(mocks.BaseWindow.instances).toHaveLength(1);
    expect(mocks.BaseWindow.instances[0].setPosition).toHaveBeenCalledWith(100, 100);
    menu.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("opens a child surface and resolves when it is visible", async () => {
    mocks.latestPress = {
      windowId: "parent-1",
      x: 12,
      y: 34,
      touch: false,
      ageMs: 0,
    };
    const menu = new AppMenu([item("play")]);
    const showing = menu.show(mocks.parentWindow as never);
    const rootView = await waitForView();
    await driveSurface(rootView);
    await showing;

    const rootPrepare = rootView.sent.find((message) => message.channel === "menu.surface.prepare")!
      .payload as { id: string };
    const opening = rootView.handlers.get("menu.surface.openChild")!(
      {},
      {
        parentId: rootPrepare.id,
        depth: 1,
        itemRect: { x: 20, y: 30, width: 0, height: 10 },
        items: [item("child")],
        templates: {},
      }
    );

    await vi.waitFor(() =>
      expect(
        mocks.WebContentsView.instances.filter((entry) => entry !== rootView).length
      ).toBeGreaterThan(0)
    );
    for (const view of mocks.WebContentsView.instances) {
      if (view === rootView) continue;
      await view.handlers.get("menu.surface.ready")?.({});
    }
    const childView = await vi.waitFor(() => {
      const view = mocks.WebContentsView.instances.find(
        (entry) =>
          entry !== rootView &&
          entry.sent.some((message) => message.channel === "menu.surface.prepare")
      );
      if (!view) throw new Error("child surface was not prepared");
      return view;
    });
    await driveSurface(childView);
    await opening;
    const childPrepare = childView.sent.find(
      (message) => message.channel === "menu.surface.prepare"
    )!.payload as { id: string };
    expect(mocks.policy).toHaveBeenCalledWith(
      childPrepare.id,
      rootPrepare.id,
      232,
      281,
      0,
      6,
      24,
      1
    );
    menu.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("opens a layer-shell menu at the compositor-chosen output", async () => {
    mocks.layerVersion = 5;
    mocks.pointer = [100, 100];
    const menu = new AppMenu([item("play")]);
    const showing = menu.show(mocks.parentWindow as never);
    const view = await waitForView();
    await driveSurface(view);
    await showing;

    const host = mocks.BaseWindowManagedWindow.instances.find(
      (entry) => entry.setLayerShell.mock.calls.length > 0
    );
    expect(host).toBeDefined();
    const options = host!.setLayerShell.mock.calls[0]![0] as Record<string, unknown>;
    expect(options).toMatchObject({
      layer: 3,
      output: 7,
      width: 232,
      height: 281,
      anchorTop: true,
      anchorLeft: true,
      marginTop: 76,
      marginLeft: 76,
      exclusiveZone: -1,
      keyboardInteractivity: 2,
    });
    expect(mocks.BaseWindow.instances[0].setPosition).not.toHaveBeenCalled();
    menu.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("closes a pending capture window when the menu is cancelled", async () => {
    mocks.layerVersion = 5;
    mocks.pointer = [100, 100];
    let resolveLoad!: () => void;
    mocks.BaseWindow.pendingLoad = new Promise((resolve) => {
      resolveLoad = resolve;
    });
    const menu = new AppMenu([item("play")]);
    const showing = menu.show(mocks.parentWindow as never);
    await vi.waitFor(() => expect(mocks.BaseWindow.instances.length).toBeGreaterThan(0));
    const captureWindow = mocks.BaseWindow.instances[0]!;

    menu.close();
    resolveLoad();
    await showing.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(captureWindow.destroyed).toBe(true);
    expect(captureWindow.show).not.toHaveBeenCalled();
  });

  it("falls back to overlay when layer-shell capture fails", async () => {
    mocks.layerVersion = 5;
    mocks.pointer = null;
    const menu = new AppMenu([item("play")]);
    const showing = menu.show(mocks.parentWindow as never);
    await vi.waitFor(() => expect(mocks.WebContentsView.instances.length).toBeGreaterThan(1));
    for (const entry of mocks.WebContentsView.instances) {
      if (entry === mocks.WebContentsView.instances[0]) continue;
      await vi.waitFor(() => expect(entry.handlers.has("menu.surface.ready")).toBe(true));
      await entry.handlers.get("menu.surface.ready")!({});
    }
    const overlayView = await vi.waitFor(() => {
      const candidate = mocks.WebContentsView.instances.find(
        (entry) =>
          entry !== mocks.WebContentsView.instances[0] &&
          entry.sent.some((message) => message.channel === "menu.surface.prepare")
      );
      if (!candidate) throw new Error("overlay surface was not created");
      return candidate;
    });
    await driveSurface(overlayView);
    await showing;
    expect(mocks.BaseWindow.instances.length).toBeGreaterThanOrEqual(1);
    menu.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("falls back to overlay when the compositor lacks on_demand focus", async () => {
    mocks.layerVersion = 3;
    const menu = new AppMenu([item("play")]);
    const showing = menu.show(mocks.parentWindow as never);
    const view = await waitForView();
    await driveSurface(view);
    await showing;
    expect(mocks.BaseWindow.instances.length).toBeGreaterThanOrEqual(1);
    menu.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("flips the layer-shell menu left and up near an output corner", async () => {
    mocks.layerVersion = 5;
    mocks.pointer = [1900, 1000];
    const menu = new AppMenu([item("play")]);
    const showing = menu.show(mocks.parentWindow as never);
    const view = await waitForView();
    await driveSurface(view);
    await showing;

    const host = mocks.BaseWindowManagedWindow.instances.find(
      (entry) => entry.setLayerShell.mock.calls.length > 0
    );
    const options = host!.setLayerShell.mock.calls[0]![0] as Record<string, unknown>;
    expect(options).toMatchObject({
      anchorTop: false,
      anchorBottom: true,
      anchorLeft: false,
      anchorRight: true,
      marginBottom: 56,
      marginRight: 0,
    });
    menu.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("closes the layer-shell menu when keyboard focus is lost", async () => {
    mocks.layerVersion = 5;
    mocks.pointer = [100, 100];
    mocks.keyboardFocus = false;
    const menu = new AppMenu([item("play")]);
    const showing = menu.show(mocks.parentWindow as never);
    const view = await waitForView();
    await driveSurface(view);
    await showing;

    const rootWindow = mocks.BaseWindow.instances.at(-1)!;
    mocks.keyboardFocus = true;
    for (const handler of rootWindow.handlers.get("focus") ?? []) handler();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const closed = new Promise<void>((resolve) => menu.on("close", () => resolve()));
    mocks.keyboardFocus = false;
    for (const handler of rootWindow.handlers.get("blur") ?? []) handler();
    await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("menu did not close on focus loss")), 500)
      ),
    ]);
  });

  describe("AppMenu.update", () => {
    it("replaces a nested item by menu_id", () => {
      const target = item("target");
      const root = item("root");
      root.children = [target];
      const menu = new AppMenu([root]);
      const patch = item("target");

      menu.update([patch]);

      expect(root.children?.[0]).toBe(patch);
    });

    it("leaves the tree unchanged when no id matches", () => {
      const root = item("root");
      root.children = [item("child")];
      const menu = new AppMenu([root]);
      const snapshot = JSON.stringify(root);

      menu.update([item("missing")]);

      expect(JSON.stringify(root)).toBe(snapshot);
    });
  });
});
