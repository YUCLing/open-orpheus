import { beforeEach, describe, expect, it, vi } from "vitest";
import { installLoggerStub } from "../../helpers/globals";

type MenuStub = {
  update: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  setClickHandler: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn<() => void>>;
};

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<void>>(),
  menus: [] as MenuStub[],
  settings: vi.fn(),
  takePanel: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: (sender: { window: unknown }) => sender.window },
}));
vi.mock("node:os", () => ({ default: { platform: () => "linux" } }));
vi.mock("@open-orpheus/window", () => ({
  DesktopEnvironment: { Wayland: "wayland" },
  getDesktopEnvironment: () => "wayland",
}));
vi.mock("../../../src/main/calls", () => ({
  registerCallHandler: (name: string, handler: (...args: unknown[]) => Promise<void>) =>
    mocks.handlers.set(name, handler),
}));
vi.mock("../../../src/main/window", () => ({
  ManagedWindow: { fromBrowserWindow: (window: { managed: unknown }) => window.managed },
}));
vi.mock("../../../src/main/menu", () => ({
  default: class {
    update = vi.fn();
    show = vi.fn(async () => {});
    setClickHandler = vi.fn();
    listeners = new Set<() => void>();
    close = vi.fn(() => {
      for (const listener of this.listeners) listener();
    });
    on(_event: string, callback: () => void) {
      this.listeners.add(callback);
    }
    constructor(
      public items: unknown[],
      public panel: unknown
    ) {
      mocks.menus.push(this);
    }
  },
}));
vi.mock("../../../src/main/menu/tray-panel", () => ({ takeTrayPanel: mocks.takePanel }));
vi.mock("../../../src/main/settings", () => ({
  kv: { get: mocks.settings },
  events: { on: vi.fn() },
}));
vi.mock("../../../src/main/orpheus", () => ({}));
vi.mock("../../../src/main/util", () => ({}));
vi.mock("../../../src/main/shortcuts", () => ({}));
vi.mock("../../../src/main/lifecycle", () => ({}));
vi.mock("../../../src/main/windows/manage", () => ({ default: vi.fn() }));
vi.mock("../../../src/main/windows/music-desktop", () => ({ default: class {} }));

installLoggerStub();
const { rememberMenuTrigger } = await import("../../../src/main/menu/trigger");
await import("../../../src/main/calls/winhelper");

function windowFixture() {
  const listeners = new Map<string, () => void>();
  const window = {
    isDestroyed: () => false,
    isFocused: () => true,
    once: (event: string, callback: () => void) => listeners.set(event, callback),
    off: (event: string, callback: () => void) => {
      if (listeners.get(event) === callback) listeners.delete(event);
    },
    managed: { setMenu: vi.fn(), getData: vi.fn() },
    webContents: { id: 1, send: vi.fn(), isDestroyed: () => false, window: undefined as unknown },
  };
  window.webContents.window = window;
  return { window, listeners, event: { sender: window.webContents } };
}

const menuData = (tray = false) => ({
  content: JSON.stringify([{ menu_id: tray ? "exitApp" : "setting" }]),
  hotkey: "[]",
});

describe("winhelper menu request routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.menus.length = 0;
    mocks.settings.mockReset().mockResolvedValue("default");
    mocks.takePanel.mockReset().mockResolvedValue(undefined);
  });

  it("drops the renderer's routing reference when its menu closes", async () => {
    const main = windowFixture();
    await mocks.handlers.get("winhelper.popupMenu")!(main.event, menuData(), 1);
    const menu = mocks.menus[0];
    menu.close();
    await mocks.handlers.get("winhelper.updateMenu")!(main.event, menuData(), 1);
    expect(menu.update).not.toHaveBeenCalled();
  });

  it("assigns a lyrics menu to its source while routing updates and clicks to the renderer", async () => {
    const main = windowFixture();
    const lyrics = windowFixture();
    rememberMenuTrigger(main.window as never, lyrics.window as never);
    await mocks.handlers.get("winhelper.popupMenu")!(main.event, menuData(), 7);
    const menu = mocks.menus[0];
    expect(lyrics.window.managed.setMenu).toHaveBeenCalledExactlyOnceWith(menu);
    expect(main.window.managed.setMenu).not.toHaveBeenCalled();
    expect(menu.show).toHaveBeenCalledExactlyOnceWith(lyrics.window);
    await mocks.handlers.get("winhelper.updateMenu")!(main.event, menuData(), 7);
    expect(menu.update).toHaveBeenCalledExactlyOnceWith([{ menu_id: "setting" }]);
    menu.setClickHandler.mock.calls[0][0]("setting");
    expect(main.window.webContents.send).toHaveBeenCalledExactlyOnceWith(
      "channel.call",
      "winhelper.onmenuclick",
      "setting",
      7
    );
    main.listeners.get("closed")!();
    expect(menu.close).toHaveBeenCalledOnce();
    expect(main.listeners.has("closed")).toBe(false);
  });

  it("discards an old preparation after a newer menu has opened", async () => {
    const main = windowFixture();
    let complete!: (panel: undefined) => void;
    mocks.takePanel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const first = mocks.handlers.get("winhelper.popupMenu")!(main.event, menuData(true), 1);
    await vi.waitFor(() => expect(mocks.takePanel).toHaveBeenCalledOnce());
    await mocks.handlers.get("winhelper.popupMenu")!(main.event, menuData(true), 2);
    complete(undefined);
    await first;
    expect(mocks.menus).toHaveLength(1);
    expect(main.window.managed.setMenu).toHaveBeenCalledOnce();
  });

  it("does not consume a newer tray reservation after an old settings lookup completes", async () => {
    const main = windowFixture();
    let complete!: (value: string) => void;
    mocks.settings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const first = mocks.handlers.get("winhelper.popupMenu")!(main.event, menuData(true), 1);
    await mocks.handlers.get("winhelper.popupMenu")!(main.event, menuData(true), 2);
    complete("default");
    await first;
    expect(mocks.takePanel).toHaveBeenCalledOnce();
    expect(mocks.menus).toHaveLength(1);
  });

  it("cancels an old prepared panel instead of replacing the newer menu", async () => {
    const main = windowFixture();
    let complete!: (panel: unknown) => void;
    mocks.takePanel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const first = mocks.handlers.get("winhelper.popupMenu")!(main.event, menuData(true), 1);
    await vi.waitFor(() => expect(mocks.takePanel).toHaveBeenCalledOnce());
    await mocks.handlers.get("winhelper.popupMenu")!(main.event, menuData(), 2);
    const panel = { cancel: vi.fn() };
    complete(panel);
    await first;
    expect(panel.cancel).toHaveBeenCalledOnce();
    expect(mocks.menus).toHaveLength(1);
  });

  it("does not show overlay when the tray request was superseded before its next renderer call", async () => {
    mocks.takePanel.mockResolvedValue(null);
    const main = windowFixture();
    await mocks.handlers.get("winhelper.popupMenu")!(main.event, menuData(true), 1);
    expect(mocks.menus).toHaveLength(0);
  });

  it("keeps overlay fallback when the optional adapter is unavailable", async () => {
    const main = windowFixture();
    await mocks.handlers.get("winhelper.popupMenu")!(main.event, menuData(true), 1);
    expect(mocks.menus).toHaveLength(1);
    expect(mocks.menus[0].show).toHaveBeenCalledWith(main.window);
  });
});
