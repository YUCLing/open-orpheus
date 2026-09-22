import { describe, expect, it } from "vitest";

import { bindLyrics, lyricsDispatcher } from "@main/domain/lyrics";
import PlaybackController from "@main/domain/playback/PlaybackController";

/** Emittery notifies listeners from a microtask, so drain the queue first. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("lyrics dispatcher wiring", () => {
  it("mirrors playback state into the dispatcher", async () => {
    const controller = new PlaybackController();
    bindLyrics(controller);

    const seen: unknown[] = [];
    lyricsDispatcher.on("timeupdate", (e) => {
      seen.push(e.data);
    });

    await controller.emit("timeupdate", 12.5);
    await controller.emit("playbackratechange", 1.5);
    await controller.emit("advancingchange", true);
    await flush();

    expect(lyricsDispatcher.time).toBe(12.5);
    expect(lyricsDispatcher.playbackRate).toBe(1.5);
    expect(lyricsDispatcher.playState).toBe(true);
    // The dispatcher forwards the same value on to its own subscribers.
    expect(seen).toEqual([12.5]);
  });
});
