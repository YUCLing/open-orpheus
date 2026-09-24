import { beforeEach, describe, expect, it, vi } from "vitest";

import { installLoggerStub } from "../helpers/globals";

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
}));

installLoggerStub();

import {
  events,
  LifecycleState,
  setLifecycleState,
  setStartupTask,
  state,
  startupTask,
} from "../../src/main/lifecycle";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("startupTask", () => {
  // `startupTask` is module state that is only ever set once, so the first test
  // is the one that observes the untouched module.
  it("starts unset", () => {
    expect(startupTask).toBeNull();
  });

  it("records an opened local file", () => {
    setStartupTask({ type: "openFile", file: "/music/song.mp3" });

    expect(startupTask).toEqual({ type: "openFile", file: "/music/song.mp3" });
  });

  it("ignores a second task", () => {
    setStartupTask({ type: "openUrl", url: "orpheus://song/1" });

    // The first task wins and is not overwritten by a later one.
    expect(startupTask).toEqual({ type: "openFile", file: "/music/song.mp3" });
  });
});

describe("setLifecycleState", () => {
  it("tracks the current state", () => {
    setLifecycleState(LifecycleState.MainWindowCreated, {} as never);
    expect(state).toBe(LifecycleState.MainWindowCreated);

    setLifecycleState(LifecycleState.MainWindowLoaded, {} as never);
    expect(state).toBe(LifecycleState.MainWindowLoaded);
  });

  it("emits the event matching the state", async () => {
    const onStarted = vi.fn();
    events.on("started", onStarted);

    const emitted = new Promise<void>((resolve) => {
      events.once("started").then(() => resolve());
    });

    setLifecycleState(LifecycleState.Started);
    await emitted;

    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it("emits the quitting event with no payload", async () => {
    const onQuitting = vi.fn();
    events.on("quitting", onQuitting);

    const emitted = new Promise<void>((resolve) => {
      events.once("quitting").then(() => resolve());
    });

    setLifecycleState(LifecycleState.Quitting);
    await emitted;

    expect(onQuitting).toHaveBeenCalledTimes(1);
    expect(state).toBe(LifecycleState.Quitting);
  });

  it("does not emit for states without an event", () => {
    const onStarted = vi.fn();
    events.on("started", onStarted);

    setLifecycleState(LifecycleState.Starting);

    expect(state).toBe(LifecycleState.Starting);
    expect(onStarted).not.toHaveBeenCalled();
  });
});
