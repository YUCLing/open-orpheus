import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  contextBridge: { executeInMainWorld: vi.fn() },
  ipcRenderer: { on: vi.fn(), send: vi.fn() },
}));
vi.mock("../../src/preload/util", () => ({ channel: "main" }));

import {
  installPlaybackModeBridge,
  type PlaybackModeBridgeApi,
} from "../../src/preload/playbackMode";
import type { PlaybackMode } from "@shared/types/playback-mode";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface Fiber {
  child: Fiber | null;
  sibling: Fiber | null;
  memoizedProps: unknown;
  stateNode?: { current: Fiber };
}

const fiber = (props: unknown = {}, child: Fiber | null = null): Fiber => ({
  memoizedProps: props,
  child,
  sibling: null,
});

function setup() {
  const container: Record<string, unknown> = {};
  const reportMode = vi.fn();
  let command: Parameters<PlaybackModeBridgeApi["onCommand"]>[0];
  const api: PlaybackModeBridgeApi = {
    reportMode,
    onCommand: (handler) => {
      command = handler;
    },
  };
  let mode: unknown = "playOrder";
  const listeners = new Set<() => void>();
  const update = (value: unknown) => {
    mode = value;
    for (const listener of listeners) listener();
  };
  const store = {
    getState: () => ({ playing: { playingMode: mode } }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch: vi.fn(async (action: { payload: { playingMode: PlaybackMode } }) => {
      update(action.payload.playingMode);
    }),
  };
  // A fresh serialized copy verifies the same isolation boundary as Electron.
  const start = () =>
    runInNewContext(`(${installPlaybackModeBridge.toString()})(api)`, {
      api,
      document: { querySelector: () => container, body: container },
      setTimeout,
      Date,
      console,
    });
  const mount = (root: Fiber) => {
    container._reactRootContainer = { _internalRoot: { current: root } };
  };
  return {
    container,
    reportMode,
    command: (value: PlaybackMode) => command(value),
    store,
    listeners,
    update,
    start,
    mount,
  };
}

it("finds a late dva route store and synchronizes page and external changes", async () => {
  const fixture = setup();
  fixture.start();
  await vi.advanceTimersByTimeAsync(500);
  expect(fixture.reportMode).not.toHaveBeenCalled();

  const unrelated = fiber({ store: { ...fixture.store, getState: () => ({ other: {} }) } });
  unrelated.sibling = fiber({ app: { _store: fixture.store } });
  fixture.mount(fiber({}, unrelated));
  await vi.advanceTimersByTimeAsync(250);
  expect(fixture.reportMode.mock.calls).toEqual([["playOrder"]]);
  fixture.update("playOneCycle");
  fixture.update("playOneCycle");
  await fixture.command("playRandom");
  expect(fixture.store.dispatch).toHaveBeenCalledWith({
    type: "playing/switchPlayingMode",
    payload: { playingMode: "playRandom" },
  });
  expect(fixture.reportMode.mock.calls).toEqual([["playOrder"], ["playOneCycle"], ["playRandom"]]);
  expect(vi.getTimerCount()).toBe(0);
  expect(fixture.listeners.size).toBe(1);
});

it("uses the current React root and reads the Provider store", () => {
  const fixture = setup();
  const staleRoot = fiber();
  staleRoot.stateNode = { current: fiber({}, fiber({ store: fixture.store })) };
  fixture.container.__reactContainer$randomSuffix = staleRoot;
  fixture.start();
  expect(fixture.reportMode).toHaveBeenCalledWith("playOrder");
  expect(vi.getTimerCount()).toBe(0);
});

it("ignores unusable stores while traversing the rest of the tree", () => {
  const fixture = setup();
  const broken = fiber({
    store: {
      ...fixture.store,
      getState: () => {
        throw new Error("not initialized");
      },
    },
  });
  broken.child = fiber({ store: fixture.store });
  fixture.mount(broken);
  fixture.start();
  expect(fixture.reportMode).toHaveBeenCalledWith("playOrder");
});

it("propagates rejected commands without reporting an unapplied mode", async () => {
  const fixture = setup();
  fixture.mount(fiber({ store: fixture.store }));
  fixture.start();
  fixture.store.dispatch.mockRejectedValueOnce(new Error("renderer rejected"));
  await expect(fixture.command("playRandom")).rejects.toThrow("renderer rejected");
  expect(fixture.reportMode.mock.calls).toEqual([["playOrder"]]);
});

it("keeps subscriber failures from breaking page actions and can report again", () => {
  const fixture = setup();
  fixture.mount(fiber({ store: fixture.store }));
  fixture.start();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  fixture.reportMode.mockImplementationOnce(() => {
    throw new Error("bridge unavailable");
  });
  expect(() => fixture.update("playRandom")).not.toThrow();
  expect(warn).toHaveBeenCalledOnce();
  fixture.update("playRandom");
  expect(fixture.reportMode).toHaveBeenLastCalledWith("playRandom");
  expect(fixture.reportMode).toHaveBeenCalledTimes(3);
});

it("forwards raw string modes for main-process validation and ignores other values", () => {
  const fixture = setup();
  fixture.mount(fiber({ store: fixture.store }));
  fixture.start();
  fixture.update(null);
  fixture.update("futureMode");
  fixture.update("futureMode");
  expect(fixture.reportMode.mock.calls).toEqual([["playOrder"], ["futureMode"]]);
});

it("stops discovery at the deadline, including a malformed cyclic tree", async () => {
  const fixture = setup();
  const root = fiber();
  root.child = root;
  fixture.mount(root);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  fixture.start();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(vi.getTimerCount()).toBe(0);
  expect(warn).toHaveBeenCalledOnce();
});
