import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserWindow } from "electron";

// The real dispatcher is wired to the media session, so it is faked here.
const hoisted = vi.hoisted(() => ({
  /** Values reported by the dispatcher getters. */
  state: {} as Record<string, unknown>,
  /** Listeners registered by the bridge, keyed by event name. */
  listeners: new Map<
    string,
    (event: { name: string; data: unknown }) => void
  >(),
  /** Unsubscribe functions handed back by `on`. */
  unlisteners: new Map<string, ReturnType<typeof vi.fn>>(),
}));

vi.mock("../../../src/main/lyrics", () => ({
  lyricsDispatcher: {
    get lyrics() {
      return hoisted.state.lyrics;
    },
    get slogan() {
      return hoisted.state.slogan;
    },
    get playState() {
      return hoisted.state.playState;
    },
    get time() {
      return hoisted.state.time;
    },
    get playbackRate() {
      return hoisted.state.playbackRate;
    },
    on(event: string, listener: (e: { name: string; data: unknown }) => void) {
      hoisted.listeners.set(event, listener);
      const off = vi.fn();
      hoisted.unlisteners.set(event, off);
      return off;
    },
  },
}));

import { registerLyricsHandlers } from "../../../src/bridge/common/lyrics";

/** Dispatcher events and the renderer channels they are forwarded to. */
const FORWARDING = [
  ["lyricsupdate", "lyrics.lyricsStoreUpdate"],
  ["sloganupdate", "lyrics.sloganUpdate"],
  ["playstateupdate", "lyrics.playStateUpdate"],
  ["timeupdate", "lyrics.timeUpdate"],
  ["playbackratechange", "lyrics.playbackRateUpdate"],
] as const;

function createFakeWindow() {
  const send = vi.fn();
  const handle = vi.fn();
  const on = vi.fn();
  const wnd = {
    webContents: { send, ipc: { handle } },
    on,
  } as unknown as BrowserWindow;

  return {
    wnd,
    send,
    /** Invoke a handler registered through `ipc.handle` by channel name. */
    invoke(channel: string, ...args: unknown[]) {
      const call = handle.mock.calls.find(([name]) => name === channel);
      if (!call) throw new Error(`No handler registered for ${channel}`);
      return (call[1] as (...a: unknown[]) => unknown)({}, ...args);
    },
    /** Fire the `closed` listener installed by the handler. */
    close() {
      const call = on.mock.calls.find(([name]) => name === "closed");
      if (!call) throw new Error("No closed listener registered");
      return (call[1] as () => void)();
    },
  };
}

beforeEach(() => {
  hoisted.listeners.clear();
  hoisted.unlisteners.clear();
  hoisted.state = {
    lyrics: { lines: [] },
    slogan: "hello",
    playState: true,
    time: 12.5,
    playbackRate: 1.5,
  };
});

describe("registerLyricsHandlers", () => {
  it("answers a full update with every current value", async () => {
    const win = createFakeWindow();
    registerLyricsHandlers(win.wnd);

    await win.invoke("lyrics.requestFullUpdate");

    expect(win.send.mock.calls).toEqual([
      ["lyrics.lyricsStoreUpdate", { lines: [] }],
      ["lyrics.sloganUpdate", "hello"],
      ["lyrics.playStateUpdate", true],
      ["lyrics.timeUpdate", 12.5],
      ["lyrics.playbackRateUpdate", 1.5],
    ]);
  });

  it("subscribes to each dispatcher event and forwards its data", () => {
    const win = createFakeWindow();
    registerLyricsHandlers(win.wnd);

    expect([...hoisted.listeners.keys()]).toEqual(
      FORWARDING.map(([event]) => event)
    );

    for (const [event, channel] of FORWARDING) {
      hoisted.listeners.get(event)?.({ name: event, data: `${event}-data` });
      expect(win.send).toHaveBeenLastCalledWith(channel, `${event}-data`);
    }

    expect(win.send).toHaveBeenCalledTimes(FORWARDING.length);
  });

  it("unsubscribes everything once the window is closed", () => {
    const win = createFakeWindow();
    registerLyricsHandlers(win.wnd);

    win.close();

    for (const [, off] of hoisted.unlisteners) expect(off).toHaveBeenCalled();
    expect(hoisted.unlisteners.size).toBe(FORWARDING.length);
  });
});
