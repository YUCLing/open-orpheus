import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserWindow } from "electron";

// `inputRegion` branches on the platform and on the native managed window.
const hoisted = vi.hoisted(() => ({
  platform: vi.fn(() => "linux" as NodeJS.Platform),
  fromBrowserWindow: vi.fn(),
  managed: { setWindowInputRegion: vi.fn(async () => true) },
}));

vi.mock("node:os", () => ({ default: { platform: hoisted.platform } }));

vi.mock("../../../src/main/window", () => ({
  ManagedWindow: { fromBrowserWindow: hoisted.fromBrowserWindow },
}));

import { registerInputRegionHandlers } from "../../../src/bridge/common/inputRegion";

const regions = [{ x: 0, y: 0, width: 10, height: 10 }];

function createFakeWindow({ destroyed = false } = {}) {
  const send = vi.fn();
  const handle = vi.fn();
  const on = vi.fn();
  const setIgnoreMouseEvents = vi.fn();
  const wnd = {
    webContents: { send, ipc: { handle } },
    isDestroyed: () => destroyed,
    setIgnoreMouseEvents,
    on,
  } as unknown as BrowserWindow;

  return {
    wnd,
    send,
    setIgnoreMouseEvents,
    /** Invoke a handler registered through `ipc.handle` by channel name. */
    invoke(channel: string, ...args: unknown[]) {
      const call = handle.mock.calls.find(([name]) => name === channel);
      if (!call) throw new Error(`No handler registered for ${channel}`);
      return (call[1] as (...a: unknown[]) => unknown)({}, ...args);
    },
    /** Fire a window event listener installed by the handler. */
    fire(event: string) {
      const call = on.mock.calls.find(([name]) => name === event);
      if (!call) throw new Error(`No ${event} listener registered`);
      return (call[1] as () => void)();
    },
  };
}

beforeEach(() => {
  hoisted.platform.mockReturnValue("linux");
  hoisted.fromBrowserWindow.mockReset();
  hoisted.managed.setWindowInputRegion.mockReset();
  hoisted.managed.setWindowInputRegion.mockResolvedValue(true);
});

describe("registerInputRegionHandlers", () => {
  it("delegates to the managed window and returns its answer", async () => {
    hoisted.fromBrowserWindow.mockReturnValue(hoisted.managed);
    const win = createFakeWindow();
    registerInputRegionHandlers(win.wnd);

    await expect(
      win.invoke("inputRegion.setInputRegions", regions)
    ).resolves.toBe(true);
    expect(hoisted.managed.setWindowInputRegion).toHaveBeenCalledWith(regions);

    // A refusal from the native side is passed on unchanged.
    hoisted.managed.setWindowInputRegion.mockResolvedValue(false);
    await expect(
      win.invoke("inputRegion.setInputRegions", regions)
    ).resolves.toBe(false);
  });

  it("reports failure when the window is not managed", async () => {
    hoisted.fromBrowserWindow.mockReturnValue(undefined);
    const win = createFakeWindow();
    registerInputRegionHandlers(win.wnd);

    await expect(
      win.invoke("inputRegion.setInputRegions", regions)
    ).resolves.toBe(false);
  });

  it("ignores calls from a destroyed window", async () => {
    const win = createFakeWindow({ destroyed: true });
    registerInputRegionHandlers(win.wnd);

    await expect(
      win.invoke("inputRegion.setInputRegions", regions)
    ).resolves.toBe(false);
    expect(hoisted.fromBrowserWindow).not.toHaveBeenCalled();
  });

  it("clicks through regions on other platforms", async () => {
    hoisted.platform.mockReturnValue("win32");
    const win = createFakeWindow();
    registerInputRegionHandlers(win.wnd);

    await expect(
      win.invoke("inputRegion.setInputRegions", regions)
    ).resolves.toBe(true);
    expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(true, {
      forward: true,
    });
  });

  it("accepts mouse events again for an empty region list", async () => {
    hoisted.platform.mockReturnValue("darwin");
    const win = createFakeWindow();
    registerInputRegionHandlers(win.wnd);

    await expect(win.invoke("inputRegion.setInputRegions", [])).resolves.toBe(
      true
    );
    expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(false);
  });
});
