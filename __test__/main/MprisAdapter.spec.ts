import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  updates: [] as Array<Record<string, unknown>>,
  metadata: [] as unknown[],
  seeked: [] as number[],
  modes: [] as unknown[],
  handler: null as null | ((err: null, event: Record<string, unknown>) => Promise<void>),
  publishMode: vi.fn(async () => {}),
}));

vi.mock("@open-orpheus/dbus", () => ({
  MediaSession: class {
    readonly setEventHandler = vi.fn((handler) => {
      hoisted.handler = handler;
    });
    readonly setMetadata = vi.fn(async (metadata: unknown) => {
      hoisted.metadata.push(metadata);
    });
    readonly updatePlaybackState = vi.fn(async (state: Record<string, unknown>) => {
      hoisted.updates.push(state);
    });
    readonly sendSeeked = vi.fn(async (time: number) => {
      hoisted.seeked.push(time);
    });
    readonly setVolume = vi.fn(async () => {});
    readonly setPlaybackMode = vi.fn((loopStatus: string, shuffle: boolean) => {
      hoisted.modes.push({ loopStatus, shuffle });
      return hoisted.publishMode();
    });
  },
  PlaybackStatus: { Playing: 0, Paused: 1, Stopped: 2 },
}));

vi.mock("../../src/main/request", () => ({
  client: { get: vi.fn() },
}));

vi.mock("../../src/main/playback/artwork", () => ({
  artworkFileExists: vi.fn(async () => false),
  artworkFileUrl: vi.fn(() => "file:///art.jpg"),
  cacheArtwork: vi.fn(async () => "file:///art.jpg"),
  remoteArtExt: vi.fn(() => ".jpg"),
}));

import MprisAdapter from "../../src/main/playback/adapters/MprisAdapter";
import { PlaybackStatus } from "../../src/main/playback/types";

const track = { id: "1", title: "title", artist: "artist", album: "album" };
const lastUpdate = () => hoisted.updates.at(-1);

beforeEach(() => {
  hoisted.updates.length = 0;
  hoisted.metadata.length = 0;
  hoisted.seeked.length = 0;
  hoisted.modes.length = 0;
  hoisted.publishMode.mockReset();
  hoisted.publishMode.mockResolvedValue(undefined);
});

describe("MprisAdapter", () => {
  it("publishes advancing, seeked, and rate changes", () => {
    const adapter = new MprisAdapter();
    adapter.onTrack(track);
    adapter.onStatus(PlaybackStatus.Playing);
    adapter.onPosition(10, false);

    expect(lastUpdate()).toEqual({
      status: 0,
      position: 10_000_000,
      speed: 1,
      advancing: true,
      seeked: false,
    });

    adapter.onAdvancing(false);
    expect(lastUpdate()).toMatchObject({ advancing: false });

    adapter.onPosition(20, true);
    expect(lastUpdate()).toMatchObject({
      position: 20_000_000,
      advancing: true,
      seeked: true,
    });
    expect(hoisted.seeked).toEqual([20_000_000]);

    adapter.onRate(1.5);
    expect(lastUpdate()).toMatchObject({ speed: 1.5, advancing: true });
  });

  it("resets its cached position on a track change", () => {
    const adapter = new MprisAdapter();
    adapter.onTrack(track);
    adapter.onStatus(PlaybackStatus.Playing);
    adapter.onPosition(60, false);

    adapter.onTrack({ ...track, id: "2" });
    adapter.onStatus(PlaybackStatus.Paused);

    expect(lastUpdate()).toMatchObject({ position: 0, advancing: false });
  });

  it("reports actual mutually exclusive renderer modes", () => {
    const adapter = new MprisAdapter();
    for (const mode of [
      "playOrder",
      "playCycle",
      "playOneCycle",
      "playRandom",
      "playAi",
      "playFm",
    ] as const) {
      adapter.onPlaybackMode(mode);
    }
    expect(hoisted.modes).toEqual([
      { loopStatus: "None", shuffle: false },
      { loopStatus: "Playlist", shuffle: false },
      { loopStatus: "Track", shuffle: false },
      { loopStatus: "Playlist", shuffle: true },
      { loopStatus: "None", shuffle: false },
      { loopStatus: "None", shuffle: false },
    ]);
  });

  it("replies after both renderer confirmation and native mode publication", async () => {
    const adapter = new MprisAdapter();
    let finishPublish!: () => void;
    hoisted.publishMode.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishPublish = resolve;
        })
    );
    adapter.on("shuffle", async ({ data }) => {
      expect(data).toBe(true);
      adapter.onPlaybackMode("playRandom");
    });
    let settled = false;
    const pending = hoisted.handler!(null, { type: "SetShuffle", shuffle: true }).then(() => {
      settled = true;
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(settled).toBe(false);
    finishPublish();
    await pending;
    expect(settled).toBe(true);
  });

  it("forwards repeat requests and propagates renderer failure", async () => {
    const adapter = new MprisAdapter();
    adapter.on("loopStatus", ({ data }) => {
      expect(data).toBe("Track");
      throw new Error("renderer unavailable");
    });
    await expect(
      hoisted.handler!(null, { type: "SetLoopStatus", loopStatus: "Track" })
    ).rejects.toThrow();
    expect(hoisted.modes).toEqual([]);
  });
});
