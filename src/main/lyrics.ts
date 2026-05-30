import { events as lifecycleEvents } from "./lifecycle";
import LyricsDispatcher from "./lyrics/LyricsDispatcher";

export const lyricsDispatcher = new LyricsDispatcher();

// Lyrics update events are handled in calls.

lifecycleEvents.on("mainwindowcreated", (e) => {
  const mainWindow = e.data;

  mainWindow.webContents.ipc.on("lyrics.setPlayState", (event, playState) => {
    lyricsDispatcher.playState = playState;
  });

  mainWindow.webContents.ipc.on("lyrics.setTime", (event, time) => {
    lyricsDispatcher.time = time;
  });
});
