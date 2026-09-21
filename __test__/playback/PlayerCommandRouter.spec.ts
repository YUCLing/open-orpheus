import Emittery from "emittery";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MainWindowAccessor } from "@main/bootstrap/types";
import type { PlayerCommandEvents } from "@main/playback/adapters/MediaSessionAdapter";
import PlaybackController from "@main/playback/PlaybackController";
import PlayerCommandRouter from "@main/playback/PlayerCommandRouter";
import { PlaybackChange, PlaybackStatus } from "@main/playback/types";

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

const windows: MainWindowAccessor = { current: () => host.window };

const track = { id: "1", title: "title", artist: "artist", album: "album" };

/** A controller in `status`, retaining a track unless `retained` is false. */
function controllerAt(
  status: PlaybackStatus,
  retained = true
): PlaybackController {
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
  new PlayerCommandRouter(commands, player, windows);
  return { player, commands };
}

const expectToggle = () =>
  expect(send).toHaveBeenCalledWith(
    "channel.call",
    "winhelper.onHotkey",
    "play_pause_3",
    true
  );

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

    new PlayerCommandRouter(commands, player, windows);

    const subscribed = on.mock.calls.map(([eventName]) => String(eventName));
    expect(subscribed.sort()).toEqual(
      [
        "next",
        "pause",
        "play",
        "previous",
        "seek",
        "setPosition",
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
    expect(send).toHaveBeenCalledWith(
      "channel.call",
      "winhelper.onHotkey",
      "next_1",
      true
    );

    send.mockClear();
    await commands.emit("previous");
    expect(send).toHaveBeenCalledWith(
      "channel.call",
      "winhelper.onHotkey",
      "prev_1",
      true
    );
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
    const { commands } = setup(PlaybackStatus.Playing);

    await commands.emit("volume", 0.5);

    expect(send).toHaveBeenCalledWith("player.volume", 0.5);
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
