import { registerIpcHandlers } from "../register";
import { LyricsContract } from "@shared/contracts/lyrics-api";
import { lyricsDispatcher } from "../../lyrics";

export function registerLyricsHandlers(wnd: Electron.BrowserWindow) {
  registerIpcHandlers<LyricsContract>(wnd.webContents, "lyrics", {
    requestFullUpdate: async () => {
      wnd.webContents.send("lyrics.lyricsStoreUpdate", lyricsDispatcher.lyrics);
      wnd.webContents.send("lyrics.sloganUpdate", lyricsDispatcher.slogan);
      wnd.webContents.send("lyrics.playStateUpdate", lyricsDispatcher.playState);
      wnd.webContents.send("lyrics.timeUpdate", lyricsDispatcher.time);
      wnd.webContents.send("lyrics.playbackRateUpdate", lyricsDispatcher.playbackRate);
    },
  });

  const unlistenLyricsUpdate = lyricsDispatcher.on("lyricsupdate", (e) => {
    wnd.webContents.send("lyrics.lyricsStoreUpdate", e.data);
  });
  const unlistenSloganUpdate = lyricsDispatcher.on("sloganupdate", (e) => {
    wnd.webContents.send("lyrics.sloganUpdate", e.data);
  });
  const unlistenPlayStateUpdate = lyricsDispatcher.on("playstateupdate", (e) => {
    wnd.webContents.send("lyrics.playStateUpdate", e.data);
  });
  const unlistenTimeUpdate = lyricsDispatcher.on("timeupdate", (e) => {
    LOGGER.trace({ time: e.data }, "Forwarded lyrics time update");
    wnd.webContents.send("lyrics.timeUpdate", e.data);
  });
  const unlistenPlaybackRateUpdate = lyricsDispatcher.on("playbackratechange", (e) => {
    wnd.webContents.send("lyrics.playbackRateUpdate", e.data);
  });

  LOGGER.debug({ listeners: 5, prefix: "lyrics" }, "Lyrics bridge listeners installed");

  wnd.on("closed", () => {
    unlistenLyricsUpdate();
    unlistenSloganUpdate();
    unlistenPlayStateUpdate();
    unlistenTimeUpdate();
    unlistenPlaybackRateUpdate();
  });
}
