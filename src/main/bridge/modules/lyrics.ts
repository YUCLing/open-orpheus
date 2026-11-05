import { registerIpcHandlers } from "../register";
import { LyricsContract } from "@shared/contracts/lyrics-api";
import { lyricsDispatcher } from "../../lyrics";
import { sendIfAlive } from "../../util/send";

export function registerLyricsHandlers(wnd: Electron.BrowserWindow) {
  registerIpcHandlers<LyricsContract>(wnd.webContents, "lyrics", {
    requestFullUpdate: async () => {
      sendIfAlive(wnd, "lyrics.lyricsStoreUpdate", lyricsDispatcher.lyrics);
      sendIfAlive(wnd, "lyrics.sloganUpdate", lyricsDispatcher.slogan);
      sendIfAlive(wnd, "lyrics.playStateUpdate", lyricsDispatcher.playState);
      sendIfAlive(wnd, "lyrics.timeUpdate", lyricsDispatcher.time);
      sendIfAlive(wnd, "lyrics.playbackRateUpdate", lyricsDispatcher.playbackRate);
    },
  });

  const unlistenLyricsUpdate = lyricsDispatcher.on("lyricsupdate", (e) => {
    sendIfAlive(wnd, "lyrics.lyricsStoreUpdate", e.data);
  });
  const unlistenSloganUpdate = lyricsDispatcher.on("sloganupdate", (e) => {
    sendIfAlive(wnd, "lyrics.sloganUpdate", e.data);
  });
  const unlistenPlayStateUpdate = lyricsDispatcher.on("playstateupdate", (e) => {
    sendIfAlive(wnd, "lyrics.playStateUpdate", e.data);
  });
  const unlistenTimeUpdate = lyricsDispatcher.on("timeupdate", (e) => {
    LOGGER.trace({ time: e.data }, "Forwarded lyrics time update");
    sendIfAlive(wnd, "lyrics.timeUpdate", e.data);
  });
  const unlistenPlaybackRateUpdate = lyricsDispatcher.on("playbackratechange", (e) => {
    sendIfAlive(wnd, "lyrics.playbackRateUpdate", e.data);
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
