import { beforeEach, describe, expect, it, vi } from "vitest";

// memfs-backed, see `__mocks__/fs/promises.cts`.
vi.mock("node:fs/promises");

import { vol } from "memfs";

import {
  localAv3aSource,
  onlineStreamerToAv3aSource,
} from "@main/services/audio/av3a/sources";

describe("localAv3aSource", () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync("/music", { recursive: true });
  });

  it("reports the whole file as available", async () => {
    vol.writeFileSync("/music/song.m4a", Buffer.alloc(1234));

    const source = await localAv3aSource("/music/song.m4a");

    expect(source.path).toBe("/music/song.m4a");
    expect(source.totalLength).toBe(1234);
    expect(source.prefixEnd()).toBe(1234);
  });

  it("never needs to download anything", async () => {
    vol.writeFileSync("/music/song.m4a", Buffer.alloc(8));
    const source = await localAv3aSource("/music/song.m4a");

    await expect(source.ensureRange(0, 8)).resolves.toBeUndefined();
  });

  it("rejects when the file is missing", async () => {
    await expect(localAv3aSource("/music/missing.m4a")).rejects.toThrow();
  });
});

describe("onlineStreamerToAv3aSource", () => {
  function fakeStreamer() {
    return {
      tempFilePath: "/tmp/stream/abc.part",
      totalLength: 4096,
      downloadedPrefixEnd: vi.fn(() => 1024),
      ensureRangeDownloaded: vi.fn(async () => {}),
    };
  }

  it("forwards the streamer state", () => {
    const streamer = fakeStreamer();
    const source = onlineStreamerToAv3aSource(streamer as never);

    expect(source.path).toBe("/tmp/stream/abc.part");
    expect(source.totalLength).toBe(4096);
    expect(source.prefixEnd()).toBe(1024);
    expect(streamer.downloadedPrefixEnd).toHaveBeenCalled();
  });

  it("forwards range downloads", async () => {
    const streamer = fakeStreamer();
    const source = onlineStreamerToAv3aSource(streamer as never);
    const controller = new AbortController();

    await source.ensureRange(0, 512, controller.signal);

    expect(streamer.ensureRangeDownloaded).toHaveBeenCalledWith(
      0,
      512,
      controller.signal
    );
  });

  it("observes later changes of the streamer state", () => {
    const streamer = fakeStreamer();
    const source = onlineStreamerToAv3aSource(streamer as never);

    streamer.totalLength = 8192;
    streamer.downloadedPrefixEnd.mockReturnValue(2048);

    expect(source.totalLength).toBe(8192);
    expect(source.prefixEnd()).toBe(2048);
  });
});
