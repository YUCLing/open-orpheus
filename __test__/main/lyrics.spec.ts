import { beforeAll, describe, expect, it, vi } from "vitest";

// The real controller drives the OS media session, so only its events matter here.
const hoisted = vi.hoisted(() => ({
  controller: {} as Record<string, unknown>,
}));

vi.mock("@main/mediaSession", async () => {
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

let lyricsDispatcher: typeof import("@main/lyrics").lyricsDispatcher;

beforeAll(async () => {
  ({ lyricsDispatcher } = await import("@main/lyrics"));
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
});
