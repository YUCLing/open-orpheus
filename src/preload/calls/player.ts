import { ipcRenderer } from "electron";

import { player } from "../audioplayer";
import { registerCallHandler } from "../calls";
import type { PlayInfo } from "../../main/calls/player";
import { imageSize } from "../../util";

let currentMetadata: MediaMetadata | null = null;

registerCallHandler<[PlayInfo], void>("player.setInfo", (playInfo) => {
  if (!playInfo.playId) {
    navigator.mediaSession.metadata = currentMetadata = null;
    return;
  }
  navigator.mediaSession.metadata = currentMetadata = new MediaMetadata({
    title: playInfo.songName,
    artist: playInfo.artistName,
    album: playInfo.albumName,
    artwork: [96, 128, 192, 256, 384, 512].map((size) => ({
      src: imageSize(playInfo.url, size),
      sizes: `${size}x${size}`,
      type: "image/jpeg",
    })),
  });
  // Forward to main process
  ipcRenderer.invoke("channel.call", "player.setInfo", playInfo);
});

// TODO: Link mediaSession
registerCallHandler<[boolean], void>("player.setSMTCEnable", () => {
  return;
});

registerCallHandler<[number], [boolean]>("player.setTotalTime", () => {
  return [true];
});

player.on("load", () => {
  if (!currentMetadata) return;
  // Ensure media session update
  navigator.mediaSession.metadata = currentMetadata;
});
