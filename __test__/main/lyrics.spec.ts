import { beforeAll, describe, expect, it, vi } from "vitest";

// The real controller drives the OS media session, so only its events matter here.
const hoisted = vi.hoisted(() => ({
  controller: {} as Record<string, unknown>,
}));

vi.mock("../../src/main/mediaSession", async () => {
  const Emittery = (await import("emittery")).default;
  const controller = new Emittery();
  Object.assign(hoisted.controller, controller, { emit: controller.emit });
  return { playbackController: controller };
});

type Emitter = { emit(event: string, data: unknown): Promise<void> };

const emit = (event: string, data: unknown) =>
  (hoisted.controller as unknown as Emitter).emit(event, data);

/** Emittery notifies listeners from a microtask, so drain the queue first. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let lyricsDispatcher: typeof import("../../src/main/lyrics").lyricsDispatcher;

beforeAll(async () => {
  ({ lyricsDispatcher } = await import("../../src/main/lyrics"));
});

describe("lyrics dispatcher wiring", () => {
  it("mirrors playback state into the dispatcher", async () => {
    const seen: unknown[] = [];
    lyricsDispatcher.on("timeupdate", (e) => {
      seen.push(e.data);
    });

    await emit("timeupdate", 12.5);
    await emit("playbackratechange", 1.5);
    await emit("advancingchange", true);
    await flush();

    expect(lyricsDispatcher.time).toBe(12.5);
    expect(lyricsDispatcher.playbackRate).toBe(1.5);
    expect(lyricsDispatcher.playState).toBe(true);
    // The dispatcher forwards the same value on to its own subscribers.
    expect(seen).toEqual([12.5]);
  });

  it("clears lyrics and slogan when the track changes", async () => {
    lyricsDispatcher.lyrics = {
      regular: [
        {
          start_time: 0,
          end_time: 1_000,
          words: [{ text: "old song", start_time: 0, duration: 1_000 }],
        },
      ],
    };
    await flush();

    await emit("trackchanged", { id: "next" });
    await flush();
    expect(lyricsDispatcher.lyrics).toBeNull();
    expect(lyricsDispatcher.slogan).toBeNull();

    lyricsDispatcher.slogan = "old slogan";
    await flush();

    await emit("trackchanged", { id: "next-again" });
    await flush();
    expect(lyricsDispatcher.slogan).toBeNull();
  });

  it("does not notify when a track change finds no lyrics to clear", async () => {
    const listener = vi.fn();
    const off = lyricsDispatcher.on("lyricsupdate", listener);

    await emit("trackchanged", { id: "nothing-to-clear" });
    await flush();

    expect(listener).not.toHaveBeenCalled();
    off();
  });
});
