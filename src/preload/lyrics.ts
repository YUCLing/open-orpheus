import { ipcRenderer } from "electron";

import { player } from "./audioplayer";

["play", "playing"].forEach((e) => {
  player.audio.addEventListener(e, () => {
    ipcRenderer.send("lyrics.setPlayState", true);
  });
});
["pause", "stalled", "ended", "error"].forEach((e) => {
  player.audio.addEventListener(e, () => {
    ipcRenderer.send("lyrics.setPlayState", false);
  });
});

player.audio.addEventListener("timeupdate", () => {
  ipcRenderer.send("lyrics.setTime", player.audio.currentTime);
});
