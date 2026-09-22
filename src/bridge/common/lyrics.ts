import { registerIpcHandlers } from "../register";
import { LyricsContract } from "../contracts/lyrics-api";
import type LyricsDispatcher from "../../main/domain/lyrics/LyricsDispatcher";

export function registerLyricsHandlers(
  wnd: Electron.BrowserWindow,
  dispatcher: LyricsDispatcher
) {
  registerIpcHandlers<LyricsContract>(wnd.webContents, "lyrics", {
    requestFullUpdate: async () => {
      wnd.webContents.send("lyrics.lyricsStoreUpdate", dispatcher.lyrics);
      wnd.webContents.send("lyrics.sloganUpdate", dispatcher.slogan);
      wnd.webContents.send("lyrics.playStateUpdate", dispatcher.playState);
      wnd.webContents.send("lyrics.timeUpdate", dispatcher.time);
      wnd.webContents.send(
        "lyrics.playbackRateUpdate",
        dispatcher.playbackRate
      );
    },
  });

  const unlistenLyricsUpdate = dispatcher.on("lyricsupdate", (e) => {
    wnd.webContents.send("lyrics.lyricsStoreUpdate", e.data);
  });
  const unlistenSloganUpdate = dispatcher.on("sloganupdate", (e) => {
    wnd.webContents.send("lyrics.sloganUpdate", e.data);
  });
  const unlistenPlayStateUpdate = dispatcher.on("playstateupdate", (e) => {
    wnd.webContents.send("lyrics.playStateUpdate", e.data);
  });
  const unlistenTimeUpdate = dispatcher.on("timeupdate", (e) => {
    wnd.webContents.send("lyrics.timeUpdate", e.data);
  });
  const unlistenPlaybackRateUpdate = dispatcher.on(
    "playbackratechange",
    (e) => {
      wnd.webContents.send("lyrics.playbackRateUpdate", e.data);
    }
  );

  wnd.on("closed", () => {
    unlistenLyricsUpdate();
    unlistenSloganUpdate();
    unlistenPlayStateUpdate();
    unlistenTimeUpdate();
    unlistenPlaybackRateUpdate();
  });
}
