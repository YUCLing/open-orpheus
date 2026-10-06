import { beforeEach, describe, expect, it, vi } from "vitest";

import { installLoggerStub } from "../helpers/globals";

const hoisted = vi.hoisted(() => ({
  /** Resolvers for the deletions the fake streamers are holding open. */
  deletions: new Map<string, () => void>(),
  /** Streamers whose deletion should reject. */
  failing: new Set<string>(),
}));

const logger = installLoggerStub();

import { MediaEngine } from "@main/services/audio/MediaEngine";
import type { OnlineStreamer } from "@main/services/audio/OnlineStreamer";

/**
 * A streamer whose deletion the test controls. Supplied through
 * `deps.createStreamer` rather than by mocking the module, so the real one is
 * never swapped out from under another importer.
 */
class FakeStreamer {
  constructor(readonly url: string) {}

  on() {
    return this;
  }

  destroy(): Promise<void> {
    if (hoisted.failing.has(this.url)) {
      return Promise.reject(new Error(`delete failed: ${this.url}`));
    }
    return new Promise<void>((resolve) => {
      hoisted.deletions.set(this.url, resolve);
    });
  }
}

/**
 * The window comes from `deps.windows`; the cache is only read for progress
 * reporting and cache-on-complete, neither of which a teardown test reaches, so
 * it is simply absent — which the engine already tolerates.
 */
function makeEngine() {
  return new MediaEngine({
    windows: { currentWindow: () => null },
    playCache: () => null,
    createStreamer: (url) => new FakeStreamer(url) as unknown as OnlineStreamer,
  });
}

/** An online (URL) play, the only kind that owns a temp file. */
function urlPlay(url: string): Parameters<MediaEngine["activate"]>[0] {
  return { type: 4, musicurl: url, songId: url } as never;
}

/** Let already-resolved promises settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

beforeEach(() => {
  hoisted.deletions.clear();
  hoisted.failing.clear();
});

describe("MediaEngine.dispose", () => {
  it("waits for a deletion an earlier stop() left running", async () => {
    const engine = makeEngine();

    await engine.activate(urlPlay("url-a"));
    await engine.stop(); // Retires url-a without waiting for its deletion.
    await engine.activate(urlPlay("url-b"));

    let disposed = false;
    const disposal = engine.dispose().then(() => {
      disposed = true;
    });

    // Both the current stream and the one stop() retired are still deleting.
    expect(hoisted.deletions.has("url-a")).toBe(true);
    expect(hoisted.deletions.has("url-b")).toBe(true);

    hoisted.deletions.get("url-b")?.();
    await tick();
    // url-b alone must not be enough: the file stop() left behind still counts.
    expect(disposed).toBe(false);

    hoisted.deletions.get("url-a")?.();
    await disposal;
    expect(disposed).toBe(true);
  });

  it("reports a failed deletion of the current stream, and still resolves", async () => {
    const engine = makeEngine();
    await engine.activate(urlPlay("url-a"));
    hoisted.failing.add("url-a");
    logger.error.mockClear();

    await expect(engine.dispose()).resolves.toBeUndefined();

    // Resolving quietly would hide a temp file that was never deleted.
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("reports a failed deletion that stop() left running", async () => {
    const engine = makeEngine();
    await engine.activate(urlPlay("url-a"));
    hoisted.failing.add("url-a");
    logger.error.mockClear();

    await engine.stop();
    await tick();

    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("resolves when nothing is playing", async () => {
    const engine = makeEngine();

    await expect(engine.dispose()).resolves.toBeUndefined();
  });
});
