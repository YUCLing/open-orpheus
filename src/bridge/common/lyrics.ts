import { registerIpcHandlers } from "../register";
import { LyricsContract } from "../contracts/lyrics-api";
import { lyricsDispatcher } from "../../main/lyrics";
import {
  LyricsPlayStateUpdateEvent,
  LyricsSloganUpdateEvent,
  LyricsTimeUpdateEvent,
  LyricsUpdateEvent,
} from "$sharedTypes/lyrics";

export function registerLyricsHandlers(wnd: Electron.BrowserWindow) {
  registerIpcHandlers<LyricsContract>(wnd.webContents, "lyrics", {
    requestFullUpdate: async () => {
      wnd.webContents.send("lyrics.lyricsStoreUpdate", lyricsDispatcher.lyrics);
      wnd.webContents.send("lyrics.sloganUpdate", lyricsDispatcher.slogan);
      wnd.webContents.send(
        "lyrics.playStateUpdate",
        lyricsDispatcher.playState
      );
      wnd.webContents.send("lyrics.timeUpdate", lyricsDispatcher.time);
    },
  });

  const lyricsUpdateListener = ((event: LyricsUpdateEvent) => {
    wnd.webContents.send("lyrics.lyricsStoreUpdate", event.detail);
  }) as EventListener;
  lyricsDispatcher.addEventListener("lyricsupdate", lyricsUpdateListener);
  const sloganUpdateListener = ((event: LyricsSloganUpdateEvent) => {
    wnd.webContents.send("lyrics.sloganUpdate", event.detail);
  }) as EventListener;
  lyricsDispatcher.addEventListener("sloganupdate", sloganUpdateListener);
  const playStateListener = ((event: LyricsPlayStateUpdateEvent) => {
    wnd.webContents.send("lyrics.playStateUpdate", event.detail);
  }) as EventListener;
  lyricsDispatcher.addEventListener("playstateupdate", playStateListener);
  const timeListener = ((event: LyricsTimeUpdateEvent) => {
    wnd.webContents.send("lyrics.timeUpdate", event.detail);
  }) as EventListener;
  lyricsDispatcher.addEventListener("timeupdate", timeListener);

  wnd.on("closed", () => {
    lyricsDispatcher.removeEventListener("lyricsupdate", lyricsUpdateListener);
    lyricsDispatcher.removeEventListener("sloganupdate", sloganUpdateListener);
    lyricsDispatcher.removeEventListener("playstateupdate", playStateListener);
    lyricsDispatcher.removeEventListener("timeupdate", timeListener);
  });
}
