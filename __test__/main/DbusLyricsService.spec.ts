import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LyricsStore } from "@shared/types/lyrics";
import DbusLyricsService, {
  toDbusLyricsDocument,
  toDbusLyricsTrack,
  type DbusLyricsDocument,
  type DbusLyricsTrack,
  type LyricsServiceHandle,
  type LyricsSource,
  type PlaybackSource,
} from "../../src/main/lyrics/DbusLyricsService";
import type { TrackInfo } from "../../src/main/playback/types";

type Listener = (event: { name: string; data: unknown }) => void;

class FakeSource {
  private readonly listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): () => void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);

    return () => {
      const current = this.listeners.get(event) ?? [];
      this.listeners.set(
        event,
        current.filter((candidate) => candidate !== listener)
      );
    };
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener({ name: event, data: undefined });
    }
  }

  get listenerCount(): number {
    let count = 0;
    for (const listeners of this.listeners.values()) count += listeners.length;
    return count;
  }
}

class FakeLyricsSource extends FakeSource implements LyricsSource {
  lyrics: LyricsStore | null = null;
  slogan: string | null = null;
}

class FakePlaybackSource extends FakeSource implements PlaybackSource {
  snapshot: { track: TrackInfo | null; duration: number | null } = {
    track: null,
    duration: null,
  };
}

interface RecordedCall {
  operation: "setTrack" | "setLyrics" | "dispose";
  args: unknown[];
}

class FakeService implements LyricsServiceHandle {
  readonly calls: RecordedCall[] = [];
  private readonly blockers: Array<() => void> = [];
  block = false;
  failNext = false;

  setTrack(track?: DbusLyricsTrack | null): Promise<void> {
    return this.record("setTrack", [track]);
  }

  setLyrics(lyrics?: DbusLyricsDocument | null, slogan?: string | null): Promise<void> {
    return this.record("setLyrics", [lyrics, slogan]);
  }

  dispose(): Promise<void> {
    this.calls.push({ operation: "dispose", args: [] });
    return Promise.resolve();
  }

  releaseOne(): void {
    this.blockers.shift()?.();
  }

  private async record(operation: "setTrack" | "setLyrics", args: unknown[]): Promise<void> {
    this.calls.push({ operation, args });
    if (this.failNext) {
      this.failNext = false;
      throw new Error(`${operation} failed`);
    }
    if (this.block) {
      await new Promise<void>((resolve) => this.blockers.push(resolve));
    }
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a call");
    await flush();
  }
}

const store: LyricsStore = {
  regular: [
    {
      start_time: 0,
      end_time: 5_000,
      words: [{ text: "hello", start_time: 0, duration: 5_000 }],
    },
  ],
  "per-word": [
    {
      start_time: 0,
      end_time: 5_000,
      words: [
        { text: "he", start_time: 0, duration: 2_000 },
        { text: "llo", start_time: 2_000, duration: 3_000 },
      ],
    },
  ],
  translate: [
    {
      start_time: 0,
      end_time: 5_000,
      words: [{ text: "你好", start_time: 0, duration: 5_000 }],
    },
  ],
};

const track: TrackInfo = { id: "42", title: "title", artist: "artist", album: "album" };

function setup() {
  const service = new FakeService();
  const lyrics = new FakeLyricsSource();
  const playback = new FakePlaybackSource();
  const onError = vi.fn();
  const adapter = new DbusLyricsService({ service, lyrics, playback, onError });

  return { adapter, service, lyrics, playback, onError };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("conversion helpers", () => {
  it("maps the LyricsStore schema onto the napi shape", () => {
    const document = toDbusLyricsDocument(store);

    expect(document).toEqual({
      regular: [
        {
          startTime: 0,
          endTime: 5_000,
          words: [{ text: "hello", startTime: 0, duration: 5_000 }],
        },
      ],
      perWord: [
        {
          startTime: 0,
          endTime: 5_000,
          words: [
            { text: "he", startTime: 0, duration: 2_000 },
            { text: "llo", startTime: 2_000, duration: 3_000 },
          ],
        },
      ],
      translate: [
        {
          startTime: 0,
          endTime: 5_000,
          words: [{ text: "你好", startTime: 0, duration: 5_000 }],
        },
      ],
      roma: undefined,
    });
    expect(toDbusLyricsDocument(null)).toBeNull();
  });

  it("converts seconds to rounded milliseconds and keeps unknown duration", () => {
    expect(toDbusLyricsTrack(track, 12.3456)).toEqual({
      id: "42",
      title: "title",
      artist: "artist",
      album: "album",
      duration: 12_346,
    });
    expect(toDbusLyricsTrack(track, null)).toEqual({
      id: "42",
      title: "title",
      artist: "artist",
      album: "album",
      duration: undefined,
    });
    expect(toDbusLyricsTrack(null, 10)).toBeNull();
  });
});

describe("DbusLyricsService", () => {
  it("pushes the initial empty snapshot", async () => {
    const { service } = setup();
    await flush();

    expect(service.calls.map((call) => call.operation)).toEqual(["setLyrics", "setTrack"]);
    expect(service.calls[0]?.args).toEqual([null, null]);
    expect(service.calls[1]?.args).toEqual([null]);
  });

  it("forwards lyrics and slogan changes", async () => {
    const { lyrics, service } = setup();
    await flush();
    service.calls.length = 0;

    lyrics.lyrics = store;
    lyrics.emit("lyricsupdate");
    await flush();

    expect(service.calls).toEqual([
      { operation: "setLyrics", args: [toDbusLyricsDocument(store), null] },
    ]);

    service.calls.length = 0;
    // The real dispatcher clears the lyrics when a slogan is set.
    lyrics.lyrics = null;
    lyrics.slogan = "slogan";
    lyrics.emit("sloganupdate");
    await flush();

    expect(service.calls).toEqual([{ operation: "setLyrics", args: [null, "slogan"] }]);
  });

  it("forwards track and duration changes", async () => {
    const { playback, service } = setup();
    await flush();
    service.calls.length = 0;

    playback.snapshot = { track, duration: 12.3456 };
    playback.emit("trackchanged");
    await flush();

    expect(service.calls).toEqual([
      {
        operation: "setTrack",
        args: [
          {
            id: "42",
            title: "title",
            artist: "artist",
            album: "album",
            duration: 12_346,
          },
        ],
      },
    ]);

    service.calls.length = 0;
    playback.snapshot = { track, duration: 13 };
    playback.emit("durationchanged");
    await flush();

    expect(service.calls).toEqual([
      {
        operation: "setTrack",
        args: [
          {
            id: "42",
            title: "title",
            artist: "artist",
            album: "album",
            duration: 13_000,
          },
        ],
      },
    ]);
  });

  it("does not push unchanged state again", async () => {
    const { lyrics, playback, service } = setup();
    await flush();
    service.calls.length = 0;

    lyrics.emit("lyricsupdate");
    lyrics.emit("sloganupdate");
    playback.emit("trackchanged");
    playback.emit("durationchanged");
    await flush();

    expect(service.calls).toEqual([]);
  });

  it("clears the previous lyrics before publishing a changed track", async () => {
    const { lyrics, playback, service } = setup();
    await flush();
    service.calls.length = 0;

    lyrics.lyrics = store;
    lyrics.emit("lyricsupdate");
    await flush();
    service.calls.length = 0;

    playback.snapshot = {
      track: { id: "43", title: "next", artist: "artist", album: "album" },
      duration: 10,
    };
    playback.emit("trackchanged");
    await flush();

    expect(service.calls).toEqual([
      { operation: "setLyrics", args: [null, null] },
      {
        operation: "setTrack",
        args: [
          {
            id: "43",
            title: "next",
            artist: "artist",
            album: "album",
            duration: 10_000,
          },
        ],
      },
    ]);
  });

  it("serializes writes so they cannot land out of order", async () => {
    const { lyrics, service } = setup();
    await flush();
    service.calls.length = 0;

    service.block = true;
    lyrics.lyrics = store;
    lyrics.emit("lyricsupdate");
    await waitFor(() => service.calls.length === 1);

    lyrics.lyrics = { regular: [] };
    lyrics.emit("lyricsupdate");
    await flush();

    expect(service.calls).toHaveLength(1);

    service.releaseOne();
    await waitFor(() => service.calls.length === 2);
    expect(service.calls[1]?.args[0]).toEqual({ regular: [] });
  });

  it("reports a failed write and still applies the next one", async () => {
    const { lyrics, service, onError } = setup();
    await flush();
    service.calls.length = 0;

    service.failNext = true;
    lyrics.lyrics = store;
    lyrics.emit("lyricsupdate");
    await flush();

    expect(onError).toHaveBeenCalledWith(expect.any(Error), "setLyrics");

    lyrics.lyrics = { regular: [] };
    lyrics.emit("lyricsupdate");
    await flush();

    expect(service.calls.map((call) => call.operation)).toEqual(["setLyrics", "setLyrics"]);
    expect(service.calls[1]?.args[0]).toEqual({ regular: [] });
  });

  it("unsubscribes and disposes exactly once", async () => {
    const { adapter, lyrics, service } = setup();
    await flush();
    service.calls.length = 0;

    const first = adapter.dispose();
    const second = adapter.dispose();
    expect(second).toBe(first);
    await first;

    expect(lyrics.listenerCount).toBe(0);
    expect(service.calls).toEqual([{ operation: "dispose", args: [] }]);

    lyrics.emit("lyricsupdate");
    await flush();
    expect(service.calls).toEqual([{ operation: "dispose", args: [] }]);
  });
});
