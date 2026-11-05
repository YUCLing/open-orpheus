import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class BaseWindow {
    static instances: BaseWindow[] = [];
    contentView = { addChildView: vi.fn() };
    handlers = new Map<string, Array<() => void>>();
    destroyed = false;
    constructor(public options: Record<string, unknown>) {
      BaseWindow.instances.push(this);
    }
    setTitle = vi.fn();
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
    readonly id = String(BaseWindowManagedWindow.nextId++);
    window: InstanceType<typeof BaseWindow> | null = null;
    attach(window: InstanceType<typeof BaseWindow>) {
      this.window = window;
    }
    setTitle = vi.fn();
    destroy = () => {
      this.window?.destroy();
    };
    releaseNativeState = vi.fn();
    setWindowInputRegion = vi.fn(() => true);
  }

  return {
    BaseWindow,
    BaseWindowManagedWindow,
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
    policy: vi.fn(() => true),
  };
});

vi.mock("electron", () => ({
  BaseWindow: mocks.BaseWindow,
  WebContentsView: mocks.WebContentsView,
  screen: {
    getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    getDisplayNearestPoint: () => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    }),
    screenToDipPoint: (point: { x: number; y: number }) => point,
  },
}));

vi.mock("@open-orpheus/window", () => ({
  DesktopEnvironment: { Wayland: "wayland", X11: "x11", Windows: "windows" },
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
  captureCursorEnter: vi.fn(async () => null),
  captureWindowTouch: vi.fn(() => 1),
  cancelWindowTouch: vi.fn(() => true),
}));

vi.mock("../../src/main/window", () => ({
  ManagedWindow: {
    fromBrowserWindow: () => ({ id: "parent-1" }),
    fromId: () => ({ window: mocks.parentWindow }),
  },
  BaseWindowManagedWindow: mocks.BaseWindowManagedWindow,
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
    mocks.WebContentsView.instances.length = 0;
    mocks.BaseWindowManagedWindow.nextId = 1;
    mocks.policy.mockClear();
    mocks.desktop = "wayland";
    mocks.latestPress = null;
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
