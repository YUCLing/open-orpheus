import { ipcMain } from "electron";

import LyricsDispatcher from "./lyrics/LyricsDispatcher";

export const lyricsDispatcher = new LyricsDispatcher();

// Lyrics update events are handled in calls.

ipcMain.on("lyrics.setPlayState", (event, playState) => {
  lyricsDispatcher.playState = playState;
});

ipcMain.on("lyrics.setTime", (event, time) => {
  lyricsDispatcher.time = time;
});
