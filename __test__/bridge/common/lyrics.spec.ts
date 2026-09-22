import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserWindow } from "electron";

import type LyricsDispatcher from "@main/domain/lyrics/LyricsDispatcher";
import { registerLyricsHandlers } from "@bridge/common/lyrics";

/** Values reported by the dispatcher getters. */
let state: Record<string, unknown> = {};
/** Listeners registered by the bridge, keyed by event name. */
const listeners = new Map<
  string,
  (event: { name: string; data: unknown }) => void
>();
/** Unsubscribe functions handed back by `on`. */
const unlisteners = new Map<string, ReturnType<typeof vi.fn>>();

// The real dispatcher is wired to the media session, so a double stands in for it.
const dispatcher = {
  get lyrics() {
    return state.lyrics;
  },
  get slogan() {
    return state.slogan;
  },
  get playState() {
    return state.playState;
  },
  get time() {
    return state.time;
  },
  get playbackRate() {
    return state.playbackRate;
  },
  on(event: string, listener: (e: { name: string; data: unknown }) => void) {
    listeners.set(event, listener);
    const off = vi.fn();
    unlisteners.set(event, off);
    return off;
  },
} as unknown as LyricsDispatcher;

function register(wnd: BrowserWindow) {
  registerLyricsHandlers(wnd, dispatcher);
}

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
  listeners.clear();
  unlisteners.clear();
  state = {
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
    register(win.wnd);

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
    register(win.wnd);

    expect([...listeners.keys()]).toEqual(FORWARDING.map(([event]) => event));

    for (const [event, channel] of FORWARDING) {
      listeners.get(event)?.({ name: event, data: `${event}-data` });
      expect(win.send).toHaveBeenLastCalledWith(channel, `${event}-data`);
    }

    expect(win.send).toHaveBeenCalledTimes(FORWARDING.length);
  });

  it("unsubscribes everything once the window is closed", () => {
    const win = createFakeWindow();
    register(win.wnd);

    win.close();

    for (const [, off] of unlisteners) expect(off).toHaveBeenCalled();
    expect(unlisteners.size).toBe(FORWARDING.length);
  });
});
