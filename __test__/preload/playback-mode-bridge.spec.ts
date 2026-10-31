import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  installPlaybackModeBridge,
  type PlaybackModeBridgeApi,
} from "../../src/preload/playbackModeBridge";
import type { PlaybackMode } from "../../types/playback-mode";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup() {
  const window = Object.assign(new EventTarget(), { webpackJsonp: [] as unknown[] });
  const reportMode = vi.fn();
  let command: Parameters<PlaybackModeBridgeApi["onCommand"]>[0];
  const api: PlaybackModeBridgeApi = {
    reportMode,
    onCommand: (handler) => {
      command = handler;
    },
  };
  const runtime = { c: {} as Record<string, { exports: unknown }> };
  window.webpackJsonp.push = (chunk: unknown) => {
    const [, modules, entries] = chunk as [unknown, Record<string, Function>, string[][]];
    for (const [id] of entries) modules[id]({}, {}, runtime);
    return 1;
  };
  // Electron serializes the function into a different world; running a fresh
  // copy catches accidental references to module-local helpers/imports.
  runInNewContext(`(${installPlaybackModeBridge.toString()})(api)`, {
    window,
    api,
    setInterval,
    clearInterval,
    Date,
    console,
  });
  let mode: PlaybackMode = "playOrder";
  const listeners = new Set<() => void>();
  const update = (value: PlaybackMode) => {
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
  const dva = { app: null as null | { _store: typeof store } };
  runtime.c["changing-module-id"] = { exports: { a: dva } };
  return {
    window,
    reportMode,
    command: (mode: PlaybackMode) => command(mode),
    store,
    listeners,
    update,
    dva,
  };
}

it("discovers a late initialized store, reports app changes and dispatches real mode actions", async () => {
  const fixture = setup();
  await vi.advanceTimersByTimeAsync(500);
  expect(fixture.reportMode).not.toHaveBeenCalled();
  fixture.dva.app = { _store: fixture.store };
  await vi.advanceTimersByTimeAsync(250);
  expect(fixture.reportMode.mock.calls).toEqual([["playOrder"]]);
  fixture.update("playOneCycle");
  fixture.update("playOneCycle");
  expect(fixture.reportMode.mock.calls).toEqual([["playOrder"], ["playOneCycle"]]);
  await fixture.command("playRandom");
  expect(fixture.store.dispatch).toHaveBeenCalledWith({
    type: "playing/switchPlayingMode",
    payload: { playingMode: "playRandom" },
  });
  expect(fixture.reportMode.mock.calls.at(-1)).toEqual(["playRandom"]);
  expect(vi.getTimerCount()).toBe(0);
  fixture.window.dispatchEvent(new Event("pagehide"));
  expect(fixture.listeners.size).toBe(0);
});

it("does not acknowledge rejected renderer commands", async () => {
  const fixture = setup();
  fixture.dva.app = { _store: fixture.store };
  await vi.advanceTimersByTimeAsync(250);
  fixture.store.dispatch.mockRejectedValueOnce(new Error("renderer rejected"));
  await expect(fixture.command("playRandom")).rejects.toThrow("renderer rejected");
  expect(fixture.reportMode.mock.calls).toEqual([["playOrder"]]);
});

it("stops discovery when the pack has no compatible playing store", async () => {
  setup();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await vi.advanceTimersByTimeAsync(30_000);
  expect(vi.getTimerCount()).toBe(0);
  expect(warn).toHaveBeenCalledOnce();
  warn.mockRestore();
});
