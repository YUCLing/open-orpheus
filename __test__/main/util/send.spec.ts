import type { BrowserWindow, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import { sendIfAlive } from "../../../src/main/util/send";

type FakeContents = {
  isDestroyed: () => boolean;
  send: ReturnType<typeof vi.fn>;
};

type FakeWindow = {
  isDestroyed: () => boolean;
  webContents: FakeContents;
};

function makeContents(destroyed = false): FakeContents {
  return {
    isDestroyed: () => destroyed,
    send: vi.fn(),
  };
}

function makeWindow(contents: FakeContents, destroyed = false): FakeWindow {
  return {
    isDestroyed: () => destroyed,
    webContents: contents,
  };
}

describe("sendIfAlive", () => {
  it("does nothing for a missing target", () => {
    expect(sendIfAlive(null, "channel")).toBe(false);
    expect(sendIfAlive(undefined, "channel")).toBe(false);
  });

  it("does not touch webContents when the window is destroyed", () => {
    const wnd = {
      isDestroyed: () => true,
    } as FakeWindow;
    Object.defineProperty(wnd, "webContents", {
      get() {
        throw new Error("webContents must not be read for a destroyed window");
      },
    });

    expect(sendIfAlive(wnd as unknown as BrowserWindow, "channel")).toBe(false);
  });

  it("skips a live window whose webContents is destroyed", () => {
    const contents = makeContents(true);
    const wnd = makeWindow(contents);

    expect(sendIfAlive(wnd as unknown as BrowserWindow, "channel", 1)).toBe(false);
    expect(contents.send).not.toHaveBeenCalled();
  });

  it("sends through a live BrowserWindow", () => {
    const contents = makeContents();
    const wnd = makeWindow(contents);
    const payload = { id: 1 };

    expect(sendIfAlive(wnd as unknown as BrowserWindow, "channel", 1, "value", payload)).toBe(true);
    expect(contents.send).toHaveBeenCalledWith("channel", 1, "value", payload);
  });

  it("sends directly to a live WebContents", () => {
    const contents = makeContents();

    expect(sendIfAlive(contents as unknown as WebContents, "channel", true)).toBe(true);
    expect(contents.send).toHaveBeenCalledWith("channel", true);
  });

  it("skips a destroyed WebContents", () => {
    const contents = makeContents(true);

    expect(sendIfAlive(contents as unknown as WebContents, "channel")).toBe(false);
    expect(contents.send).not.toHaveBeenCalled();
  });
});
