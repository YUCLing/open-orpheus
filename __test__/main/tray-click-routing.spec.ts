import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  note: vi.fn(),
  register: vi.fn(),
  release: vi.fn(),
  setContextMenu: vi.fn(),
  destroy: vi.fn(),
  settings: vi.fn(),
  visible: false,
}));
vi.mock("electron", () => ({
  app: { quit: vi.fn() },
  Menu: { buildFromTemplate: (items: unknown[]) => items },
  nativeImage: { createFromPath: () => ({}) },
  Tray: class {
    setToolTip = vi.fn();
    setImage = vi.fn();
    on = vi.fn();
    off = vi.fn();
    setContextMenu = mocks.setContextMenu;
    destroy = mocks.destroy;
  },
}));
vi.mock("../../src/main/window", () => ({
  mainWindow: {
    isDestroyed: () => false,
    isVisible: () => mocks.visible,
    webContents: { id: 12, send: mocks.send },
  },
}));
vi.mock("../../src/main/settings", () => ({ kv: { get: mocks.settings } }));
vi.mock("../../src/main/lifecycle", () => ({ registerShutdownTask: vi.fn() }));
vi.mock("../../src/main/windows/manage", () => ({ default: vi.fn() }));
vi.mock("../../src/main/menu/tray-panel", () => ({ noteTrayMenuRequest: mocks.note }));
vi.mock("../../src/main/menu/tray-activation", () => ({ registerTrayActivation: mocks.register }));

describe.skipIf(process.platform !== "linux")("GNOME left-click music panel routing", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.register.mockReturnValue(mocks.release);
  });
  async function fixture() {
    const tray = await import("../../src/main/tray");
    tray.setIcon({} as never);
    tray.install();
    return tray;
  }
  it.each([true, false])(
    "opens the music panel when main-window visibility is %s",
    async (visible) => {
      mocks.visible = visible;
      const tray = await fixture();
      mocks.register.mock.calls[0][0]();
      expect(mocks.note).toHaveBeenCalledExactlyOnceWith(12);
      expect(mocks.send).toHaveBeenCalledExactlyOnceWith("channel.call", "trayicon.onrightclick");
      expect(mocks.settings).not.toHaveBeenCalled();
      tray.uninstall();
    }
  );
  it("keeps the music-menu entry alongside management and quit with scoped activation", async () => {
    const tray = await fixture();
    const menu = mocks.setContextMenu.mock.calls.at(-1)![0];
    expect(menu.map((item: { label?: string }) => item.label)).toEqual([
      "显示网易云音乐菜单",
      undefined,
      "管理 Open Orpheus",
      "退出",
    ]);
    menu[0].click();
    expect(mocks.note).toHaveBeenCalledExactlyOnceWith(12);
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith("channel.call", "trayicon.onrightclick");
    expect(mocks.register.mock.calls[0]).toHaveLength(1);
    tray.uninstall();
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
