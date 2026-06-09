import os from "node:os";

import Emittery from "emittery";

import MprisMediaSession from "./mediaSession/mpris";
import { events as lifecycleEvents } from "./lifecycle";
import { mainWindow } from "./window";

export type MediaSessionEvents = {
  raise: undefined;
  quit: undefined;
  play: undefined;
  pause: undefined;
  next: undefined;
  previous: undefined;
  seek: number;
  position: number;
  volume: number;
};

export interface Metadata {
  id: string;
  title: string;
  artist: string;
  album: string;
  url: string;
}

export interface IMediaSession extends Emittery<MediaSessionEvents> {
  setMetadata(metadata: Metadata | null): void;
  /**
   *
   * @param position null refers to no playback.
   */
  updatePosition(position: number | null, seeked?: boolean): void;
  updateDuration(duration: number | null): void;
  updateState(paused: boolean): void;
  updatePlaybackRate(rate: number): void;
  updateVolume(volume: number): void;
}

class StubMediaSession
  extends Emittery<MediaSessionEvents>
  implements IMediaSession
{
  updatePosition(): void {}
  updateDuration(): void {}
  updateState(): void {}
  updateVolume(): void {}
  setMetadata(): void {}
  updatePlaybackRate(): void {}
}

export async function createMediaSession(): Promise<void> {
  switch (os.platform()) {
    case "linux":
      mediaSession = new MprisMediaSession();
      break;
    default:
      console.warn("Media session is not available on this platform.");
      mediaSession = new StubMediaSession();
  }

  (["play", "pause"] as const).forEach((v) => {
    mediaSession.on(v, () => {
      mainWindow?.webContents.send(
        "channel.call",
        "winhelper.onHotkey",
        "play_pause_3",
        true
      );
    });
  });
  mediaSession.on("next", () => {
    mainWindow?.webContents.send(
      "channel.call",
      "winhelper.onHotkey",
      "next_1",
      true
    );
  });
  mediaSession.on("previous", () => {
    mainWindow?.webContents.send(
      "channel.call",
      "winhelper.onHotkey",
      "prev_1",
      true
    );
  });
  mediaSession.on("position", (e) => {
    mainWindow?.webContents.send("player.seekto", e.data);
  });
  mediaSession.on("seek", (e) => {
    mainWindow?.webContents.send("player.seek", e.data);
  });
}

export let mediaSession: IMediaSession = null!;

lifecycleEvents.on("mainwindowcreated", (e) => {
  const mainWindow = e.data;

  mainWindow.webContents.ipc.on("player.timeupdate", (e, time) => {
    mediaSession.updatePosition(time);
  });

  mainWindow.webContents.ipc.on("player.seeked", (e, time) => {
    mediaSession.updatePosition(time, true);
  });

  mainWindow.webContents.ipc.on("player.durationchange", (e, duration) => {
    mediaSession.updateDuration(duration);
  });

  mainWindow.webContents.ipc.on("player.playbackratechange", (e, rate) => {
    mediaSession.updatePlaybackRate(rate);
  });

  mainWindow.webContents.ipc.on("player.statechange", (e, state) => {
    mediaSession.updateState(state);
  });
});
