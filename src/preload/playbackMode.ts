import { contextBridge, ipcRenderer } from "electron";

import { channel } from "./util";
import { isPlaybackMode, type PlaybackMode } from "$sharedTypes/playback-mode";
import { installPlaybackModeBridge } from "./playbackModeBridge";

if (channel === "main" && process.platform === "linux") {
  let command: ((mode: PlaybackMode) => Promise<void>) | undefined;
  ipcRenderer.on("player.playbackmode", (_event, mode: unknown) => {
    if (!isPlaybackMode(mode)) return;
    if (!command) {
      LOGGER.warn("Renderer playback-mode integration is not ready");
      return;
    }
    void command(mode).catch((err) => {
      LOGGER.warn({ err }, "Renderer rejected playback-mode change");
    });
  });
  contextBridge.executeInMainWorld({
    func: installPlaybackModeBridge,
    args: [
      {
        reportMode: (mode: PlaybackMode) => ipcRenderer.send("player.playbackmodechange", mode),
        onCommand: (handler: (mode: PlaybackMode) => Promise<void>) => {
          command = handler;
        },
      },
    ],
  });
}
