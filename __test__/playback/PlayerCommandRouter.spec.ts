import Emittery from "emittery";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlayerCommandEvents } from "../../src/main/playback/adapters/MediaSessionAdapter";
import PlaybackController from "../../src/main/playback/PlaybackController";
import PlayerCommandRouter from "../../src/main/playback/PlayerCommandRouter";
import { PlaybackChange, PlaybackStatus } from "../../src/main/playback/types";

// `../window` pulls in Electron; the router only needs `webContents.send`.
const { send, host } = vi.hoisted(() => {
  const send = vi.fn();
  return {
    send,
    /** Mutable so a test can model a window that is not available (yet). */
    host: { window: null } as {
      window: { webContents: { send: typeof send } } | null;
    },
  };
});
vi.mock("../../src/main/window", () => ({
  get mainWindow() {
    return host.window;
  },
}));

const track = { id: "1", title: "title", artist: "artist", album: "album" };

/** A controller in `status`, retaining a track unless `retained` is false. */
function controllerAt(status: PlaybackStatus, retained = true): PlaybackController {
  const player = new PlaybackController();
  if (retained) player.setTrack(track);
  if (status === PlaybackStatus.Playing) {
    player.applyPlaybackChange(PlaybackChange.Playing);
  } else if (status === PlaybackStatus.Paused) {
    player.applyPlaybackChange(PlaybackChange.Paused);
  }
  return player;
}

function setup(status: PlaybackStatus, retained = true) {
  const player = controllerAt(status, retained);
  const commands = new Emittery<PlayerCommandEvents>();
  new PlayerCommandRouter(commands, player);
  return { player, commands };
}

const expectToggle = () =>
  expect(send).toHaveBeenCalledWith("channel.call", "winhelper.onHotkey", "play_pause_3", true);

/** Let Emittery reach (and run) its listeners before asserting on them. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  send.mockClear();
  host.window = { webContents: { send } };
});

describe("PlayerCommandRouter playback translation", () => {
  it("toggles once for `play` while paused", async () => {
    const { commands } = setup(PlaybackStatus.Paused);
    await commands.emit("play");
    expect(send).toHaveBeenCalledTimes(1);
    expectToggle();
  });

  it("does not toggle for `pause` while paused", async () => {
    const { commands } = setup(PlaybackStatus.Paused);
    await commands.emit("pause");
    expect(send).not.toHaveBeenCalled();
  });

  it("does not toggle for `play` while playing", async () => {
    const { commands } = setup(PlaybackStatus.Playing);
    await commands.emit("play");
    expect(send).not.toHaveBeenCalled();
  });

  it("revives a retained track when `play` arrives while stopped", async () => {
    const { commands } = setup(PlaybackStatus.Stopped, true);
    await commands.emit("play");
    expect(send).toHaveBeenCalledTimes(1);
    expectToggle();
  });

  it("ignores `play` while stopped without a track", async () => {
    const { commands } = setup(PlaybackStatus.Stopped, false);
    await commands.emit("play");
    expect(send).not.toHaveBeenCalled();
  });

  it("does not toggle for `pause` while stopped", async () => {
    const { commands } = setup(PlaybackStatus.Stopped);
    await commands.emit("pause");
    expect(send).not.toHaveBeenCalled();
  });

  it("coalesces repeated `play`s until the renderer confirms", async () => {
    const { commands } = setup(PlaybackStatus.Paused);
    await commands.emit("play");
    await commands.emit("play");
    await commands.emit("play");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("drops a repeat once the renderer confirms playback", async () => {
    const { player, commands } = setup(PlaybackStatus.Paused);
    await commands.emit("play");
    player.applyPlaybackChange(PlaybackChange.Playing); // renderer confirmation
    await commands.emit("play");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("honours `pause` after playback is confirmed", async () => {
    const { player, commands } = setup(PlaybackStatus.Paused);
    await commands.emit("play");
    player.applyPlaybackChange(PlaybackChange.Playing);
    await commands.emit("pause");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("keeps a queued `pause` while the earlier `play` confirms", async () => {
    const { player, commands } = setup(PlaybackStatus.Paused);
    await commands.emit("play"); // toggle #1 → expects Playing
    await commands.emit("pause"); // toggle #2 → expects Paused
    player.applyPlaybackChange(PlaybackChange.Playing); // toggle #1 lands
    await commands.emit("pause"); // must not queue a third (cancelling) toggle
    expect(send).toHaveBeenCalledTimes(2);
    player.applyPlaybackChange(PlaybackChange.Paused); // toggle #2 lands
    await commands.emit("play"); // now a real transition is needed again
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("resyncs when a transition matches nothing in flight", async () => {
    const { player, commands } = setup(PlaybackStatus.Paused);
    await commands.emit("play"); // one toggle in flight → expects Playing
    // The renderer reports a status we never asked for (the song ended rather
    // than resuming): trust the report and forget the backlog.
    player.applyPlaybackChange(PlaybackChange.Stopped);
    await commands.emit("play"); // retained track ⇒ revivable again
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("PlayerCommandRouter command routing", () => {
  it("subscribes to every media-session command", () => {
    const player = controllerAt(PlaybackStatus.Paused);
    const commands = new Emittery<PlayerCommandEvents>();
    const on = vi.spyOn(commands, "on");

    new PlayerCommandRouter(commands, player);

    const subscribed = on.mock.calls.map(([eventName]) => String(eventName));
    expect(subscribed.sort()).toEqual(
      [
        "loopStatus",
        "next",
        "pause",
        "play",
        "previous",
        "seek",
        "setPosition",
        "shuffle",
        "toggle",
        "volume",
      ].sort()
    );
  });

  it("honours an explicit `toggle` while playing", async () => {
    const { commands } = setup(PlaybackStatus.Playing);

    await commands.emit("toggle");

    expect(send).toHaveBeenCalledTimes(1);
    expectToggle();
  });

  it("maps next and previous onto their hotkeys", async () => {
    const { commands } = setup(PlaybackStatus.Paused);

    await commands.emit("next");
    expect(send).toHaveBeenCalledWith("channel.call", "winhelper.onHotkey", "next_1", true);

    send.mockClear();
    await commands.emit("previous");
    expect(send).toHaveBeenCalledWith("channel.call", "winhelper.onHotkey", "prev_1", true);
  });

  it("keeps relative and absolute seeks on separate channels", async () => {
    const { commands } = setup(PlaybackStatus.Playing);

    await commands.emit("seek", 5000);
    expect(send).toHaveBeenCalledWith("player.seek", 5000);

    send.mockClear();
    await commands.emit("setPosition", 12000);
    expect(send).toHaveBeenCalledWith("player.seekto", 12000);
  });

  it("forwards volume changes", async () => {
    const { player, commands } = setup(PlaybackStatus.Playing);

    const emitted = commands.emit("volume", 0.5);
    await flushMicrotasks();
    expect(send).toHaveBeenCalledWith("player.volume", 0.5);

    player.applyVolume(0.5); // renderer reports it back
    await emitted;
  });

  it("stays silent when there is no main window", async () => {
    const { commands } = setup(PlaybackStatus.Paused);
    host.window = null;

    await commands.emit("next");
    await commands.emit("previous");
    await commands.emit("seek", 1);
    await commands.emit("setPosition", 2);
    await commands.emit("volume", 0.5);
    await commands.emit("play"); // routed through the same window seam

    expect(send).not.toHaveBeenCalled();
  });
});

describe("PlayerCommandRouter volume handshake", () => {
  it("waits for the renderer to report the volume back", async () => {
    const { player, commands } = setup(PlaybackStatus.Playing);
    let settled = false;

    const emitted = commands.emit("volume", 0.5).then(() => {
      settled = true;
    });
    await flushMicrotasks();

    expect(send).toHaveBeenCalledWith("player.volume", 0.5);
    expect(settled).toBe(false);

    player.applyVolume(0.5); // renderer confirmation
    await emitted;
    expect(settled).toBe(true);
  });

  it("does not wait when the renderer already has that volume", async () => {
    const { player, commands } = setup(PlaybackStatus.Playing);
    player.applyVolume(0.5);

    await commands.emit("volume", 0.5);

    expect(send).toHaveBeenCalledWith("player.volume", 0.5);
  });

  it("releases each request only on its own value", async () => {
    const { player, commands } = setup(PlaybackStatus.Playing);
    const settled: string[] = [];

    const first = commands.emit("volume", 0.5).then(() => settled.push("0.5"));
    const second = commands.emit("volume", 0.2).then(() => settled.push("0.2"));
    await flushMicrotasks();

    player.applyVolume(0.5); // the first request's value only
    await flushMicrotasks();
    expect(settled).toEqual(["0.5"]); // 0.2 must not be released by it

    player.applyVolume(0.2);
    await Promise.all([first, second]);
    expect(settled.sort()).toEqual(["0.2", "0.5"]);
  });

  it("fails when the renderer never confirms the value", async () => {
    vi.useFakeTimers();
    try {
      const { commands } = setup(PlaybackStatus.Playing);
      const outcome = commands.emit("volume", 0.5).then(
        () => "resolved",
        () => "rejected"
      );
      await flushMicrotasks();
      expect(send).toHaveBeenCalledWith("player.volume", 0.5);

      await vi.advanceTimersByTimeAsync(5000); // well past the volume TTL
      expect(await outcome).toBe("rejected");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails when the send itself throws", async () => {
    const { commands } = setup(PlaybackStatus.Playing);
    send.mockImplementationOnce(() => {
      throw new Error("Object has been destroyed");
    });

    // Emittery wraps listener errors, so only the rejection is observable here.
    await expect(commands.emit("volume", 0.5)).rejects.toThrow();
  });
});

describe("PlayerCommandRouter playback modes", () => {
  it.each([
    ["playOrder", "shuffle", true, "playRandom"],
    ["playOneCycle", "shuffle", true, "playRandom"],
    ["playRandom", "shuffle", false, "playCycle"],
    ["playRandom", "loopStatus", "Track", "playOneCycle"],
    ["playRandom", "loopStatus", "None", "playOrder"],
    ["playOrder", "loopStatus", "Playlist", "playCycle"],
  ] as const)("confirms %s + %s=%s as %s", async (current, command, value, target) => {
    const { player, commands } = setup(PlaybackStatus.Paused);
    player.applyPlaybackMode(current);
    const pending =
      command === "shuffle"
        ? commands.emit(command, value as boolean)
        : commands.emit(command, value as "Track" | "None" | "Playlist");
    await flushMicrotasks();
    expect(send).toHaveBeenLastCalledWith("player.playbackmode", target);
    expect(player.snapshot.playbackMode).toBe(current);
    player.applyPlaybackMode(target);
    await pending;
  });

  it("keeps random order when enabling playlist repeat and skips unchanged writes", async () => {
    const { player, commands } = setup(PlaybackStatus.Paused);
    player.applyPlaybackMode("playRandom");
    await commands.emit("loopStatus", "Playlist");
    await commands.emit("shuffle", true);
    expect(send).not.toHaveBeenCalled();
  });

  it("serializes overlapping requests using each preceding confirmed mode", async () => {
    const { player, commands } = setup(PlaybackStatus.Paused);
    player.applyPlaybackMode("playOrder");
    const first = commands.emit("shuffle", true);
    const second = commands.emit("shuffle", false);
    await flushMicrotasks();
    expect(send).toHaveBeenCalledTimes(1);
    player.applyPlaybackMode("playRandom");
    await first;
    await flushMicrotasks();
    expect(send).toHaveBeenLastCalledWith("player.playbackmode", "playCycle");
    player.applyPlaybackMode("playCycle");
    await second;
  });

  it("rejects writes before initialization or without a window", async () => {
    const { player, commands } = setup(PlaybackStatus.Paused);
    await expect(commands.emit("shuffle", true)).rejects.toThrow();
    player.applyPlaybackMode("playOrder");
    host.window = null;
    await expect(commands.emit("loopStatus", "Track")).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("times out unconfirmed writes and permits subsequent requests", async () => {
    vi.useFakeTimers();
    try {
      const { player, commands } = setup(PlaybackStatus.Paused);
      player.applyPlaybackMode("playOrder");
      const first = commands.emit("shuffle", true).catch(() => "rejected");
      await flushMicrotasks();
      player.applyPlaybackMode("playOneCycle"); // a different report cannot confirm random
      await vi.advanceTimersByTimeAsync(3500);
      expect(await first).toBe("rejected");
      const next = commands.emit("loopStatus", "Playlist");
      await flushMicrotasks();
      player.applyPlaybackMode("playCycle");
      await next;
      expect(player.listenerCount("modechanged")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
