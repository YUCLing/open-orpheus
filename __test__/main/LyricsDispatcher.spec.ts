import { beforeEach, describe, expect, it, vi } from "vitest";

import LyricsDispatcher from "@main/lyrics/LyricsDispatcher";

type Recorded = { event: string; data: unknown };

/** Emittery invokes listeners from a microtask, so drain the queue before asserting. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("LyricsDispatcher", () => {
  let dispatcher: LyricsDispatcher;
  let recorded: Recorded[];

  beforeEach(() => {
    dispatcher = new LyricsDispatcher();
    recorded = [];
    for (const event of [
      "lyricsupdate",
      "sloganupdate",
      "playstateupdate",
      "timeupdate",
      "playbackratechange",
    ] as const) {
      // Emittery v2 hands listeners a `{ name, data }` event object.
      dispatcher.on(event, (e: unknown) => {
        const { name, data } = e as { name: string; data: unknown };
        recorded.push({ event: name, data });
      });
    }
  });

  it("starts empty", () => {
    expect(dispatcher.lyrics).toBeNull();
    expect(dispatcher.slogan).toBeNull();
    expect(dispatcher.playState).toBe(false);
    expect(dispatcher.time).toBe(0);
    expect(dispatcher.playbackRate).toBe(1);
  });

  it("emits the lyrics and clears the slogan", async () => {
    const lyrics = { regular: [{ start_time: 0, end_time: 1, words: [] }] };
    dispatcher.lyrics = lyrics;
    await Promise.resolve();

    expect(dispatcher.lyrics).toBe(lyrics);
    expect(dispatcher.slogan).toBeNull();
    expect(recorded).toEqual([
      { event: "sloganupdate", data: null },
      { event: "lyricsupdate", data: lyrics },
    ]);
  });

  it("emits the slogan and clears the lyrics", async () => {
    dispatcher.slogan = "Enjoy the music";
    await Promise.resolve();

    expect(dispatcher.slogan).toBe("Enjoy the music");
    expect(dispatcher.lyrics).toBeNull();
    expect(recorded).toEqual([
      { event: "lyricsupdate", data: null },
      { event: "sloganupdate", data: "Enjoy the music" },
    ]);
  });

  it("clears the slogan when new lyrics arrive", async () => {
    dispatcher.slogan = "slogan";
    await flush();
    recorded = [];

    dispatcher.lyrics = { regular: [] };
    await flush();

    expect(dispatcher.slogan).toBeNull();
    expect(recorded).toEqual([
      { event: "sloganupdate", data: null },
      { event: "lyricsupdate", data: { regular: [] } },
    ]);
  });

  it("keeps the slogan when the lyrics are cleared", async () => {
    dispatcher.slogan = "slogan";
    await flush();
    recorded = [];

    dispatcher.lyrics = null;
    await flush();

    expect(dispatcher.slogan).toBe("slogan");
    expect(recorded).toEqual([{ event: "lyricsupdate", data: null }]);
  });

  it("emits playback state changes", async () => {
    dispatcher.playState = true;
    dispatcher.time = 12.5;
    dispatcher.playbackRate = 1.5;
    await Promise.resolve();

    expect(dispatcher.playState).toBe(true);
    expect(dispatcher.time).toBe(12.5);
    expect(dispatcher.playbackRate).toBe(1.5);
    expect(recorded).toEqual([
      { event: "playstateupdate", data: true },
      { event: "timeupdate", data: 12.5 },
      { event: "playbackratechange", data: 1.5 },
    ]);
  });

  it("stops notifying unsubscribed listeners", async () => {
    const listener = vi.fn();
    const off = dispatcher.on("timeupdate", listener);

    dispatcher.time = 1;
    await Promise.resolve();
    off();
    dispatcher.time = 2;
    await Promise.resolve();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ name: "timeupdate", data: 1 });
  });
});
