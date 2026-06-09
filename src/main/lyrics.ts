import { events as lifecycleEvents } from "./lifecycle";
import LyricsDispatcher from "./lyrics/LyricsDispatcher";

export const lyricsDispatcher = new LyricsDispatcher();

// Lyrics update events are handled in calls.

lifecycleEvents.on("mainwindowcreated", (e) => {
  const mainWindow = e.data;

  mainWindow.webContents.ipc.on("player.statechange", (event, playState) => {
    lyricsDispatcher.playState = playState;
  });

  mainWindow.webContents.ipc.on("player.timeupdate", (event, time) => {
    lyricsDispatcher.time = time;
  });
});
