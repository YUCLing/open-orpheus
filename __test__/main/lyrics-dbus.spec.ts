import os from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installLoggerStub } from "../helpers/globals";

const logger = installLoggerStub();

const hoisted = vi.hoisted(() => ({
  constructorArgs: null as unknown[] | null,
  constructorCalls: 0,
  failStart: false,
  instance: null as null | {
    start: ReturnType<typeof vi.fn>;
    setTrack: ReturnType<typeof vi.fn>;
    setLyrics: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  },
  tasks: [] as Array<{ name: string; run: () => void | Promise<void> }>,
}));

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  hoisted.constructorArgs = null;
  hoisted.constructorCalls = 0;
  hoisted.failStart = false;
  hoisted.instance = null;
  hoisted.tasks.length = 0;

  vi.spyOn(os, "platform").mockReturnValue("linux");

  vi.doMock("../../src/main/lyrics", () => ({
    lyricsDispatcher: {
      lyrics: null,
      slogan: null,
      on: () => () => {},
    },
  }));

  vi.doMock("../../src/main/mediaSession", () => ({
    playbackController: {
      snapshot: { track: null, duration: null },
      on: () => () => {},
    },
  }));

  vi.doMock("../../src/main/lifecycle", () => ({
    registerShutdownTask: (task: { name: string; run: () => void | Promise<void> }) => {
      hoisted.tasks.push(task);
    },
  }));

  vi.doMock("@open-orpheus/dbus", () => ({
    LyricsService: class {
      readonly start = vi.fn(async () => {
        if (hoisted.failStart) throw new Error("no session bus");
      });
      readonly setTrack = vi.fn(async () => {});
      readonly setLyrics = vi.fn(async () => {});
      readonly dispose = vi.fn(async () => {});

      constructor(...args: unknown[]) {
        hoisted.constructorCalls += 1;
        hoisted.constructorArgs = args;
        hoisted.instance = this;
      }
    },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function loadFactory() {
  return import("../../src/main/lyrics/dbus");
}

describe("createDbusLyricsService", () => {
  it("does nothing on non-Linux platforms", async () => {
    vi.mocked(os.platform).mockReturnValue("win32");
    const { createDbusLyricsService } = await loadFactory();

    await expect(createDbusLyricsService()).resolves.toBeNull();
    expect(hoisted.constructorCalls).toBe(0);
  });

  it("constructs the service with the documented name and path", async () => {
    const { createDbusLyricsService, DBUS_LYRICS_BUS_NAME, DBUS_LYRICS_OBJECT_PATH } =
      await loadFactory();

    const adapter = await createDbusLyricsService();

    expect(adapter).not.toBeNull();
    expect(hoisted.constructorArgs).toEqual([DBUS_LYRICS_BUS_NAME, DBUS_LYRICS_OBJECT_PATH]);
    expect(hoisted.constructorCalls).toBe(1);
    expect(hoisted.instance?.start).toHaveBeenCalledTimes(1);
  });

  it("returns the same adapter on repeated calls", async () => {
    const { createDbusLyricsService } = await loadFactory();

    const first = await createDbusLyricsService();
    const second = await createDbusLyricsService();

    expect(second).toBe(first);
    expect(hoisted.constructorCalls).toBe(1);
  });

  it("registers a shutdown task that disposes the service", async () => {
    const { createDbusLyricsService } = await loadFactory();
    await createDbusLyricsService();

    expect(hoisted.tasks).toHaveLength(1);
    expect(hoisted.tasks[0]?.name).toBe("dbus-lyrics-service");

    await hoisted.tasks[0]?.run();
    expect(hoisted.instance?.dispose).toHaveBeenCalledTimes(1);
  });

  it("logs and returns null when the native service cannot start", async () => {
    hoisted.failStart = true;
    const { createDbusLyricsService } = await loadFactory();

    await expect(createDbusLyricsService()).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalled();
    expect(hoisted.tasks).toHaveLength(0);
  });
});
