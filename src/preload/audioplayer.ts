import { ipcRenderer } from "electron";
import { fireNativeCall } from "./channel";
import Player, { AudioPlayerState, type LyricContent } from "./Player";

export const player = new Player();

let buffering = false;

function notifyBuffering(isBuffering: boolean) {
  if (buffering !== isBuffering) {
    buffering = isBuffering;
    fireNativeCall(
      "audioplayer.onBuffering",
      player.currentId,
      buffering ? 1 : 0
    );
  }
}

player.addEventListener("load", (event) => {
  const { id } = (event as CustomEvent).detail;
  console.log(`Audio loaded in preload for id: ${id}`);
  fireNativeCall("audioplayer.onLoad", id, {
    activeCode: 0,
    code: 0,
    duration: player.audio.duration || 0,
    errorCode: 0,
    errorString: "",
    openWholeCached: true,
    preloadWholeCached: false,
  });
});

player.audio.addEventListener("play", () => {
  // 1806160891_1B5MK7|resume|XEDKE2
  // 1806160891|pause|4RB6IY
  fireNativeCall(
    "audioplayer.onPlayState",
    player.currentId,
    "",
    AudioPlayerState.Playing
  );
});

player.audio.addEventListener("pause", () => {
  fireNativeCall(
    "audioplayer.onPlayState",
    player.currentId,
    "",
    AudioPlayerState.Paused
  );
});

player.audio.addEventListener("ended", () => {
  fireNativeCall("audioplayer.onEnd", player.currentId, {
    activeCode: 0,
    code: 0,
    errorCode: 0,
    errorString: "",
    playedAudioTime: player.audio.duration || 0,
    playedTime: player.audio.duration || 0,
  });
});

player.audio.addEventListener("error", async () => {
  // What to do with general errors?
  const id = player.currentId;
  const playInfo = player.currentPlayInfo;
  const [res] = await ipcRenderer.invoke("channel.call", "network.fetch", {
    url: player.audio.src,
    method: "HEAD",
    retryCount: 3,
  });
  if (player.currentId !== id) return; // Check if the current audio has changed
  if (res.status === 403) {
    fireNativeCall("audioplayer.onrequestrefreshsongurl", playInfo);
  }
});

player.audio.addEventListener("seeked", () => {
  fireNativeCall(
    "audioplayer.onSeek",
    player.currentId,
    "",
    0,
    player.audio.currentTime
  );
  notifyBuffering(true);
});

player.audio.addEventListener("stalled", () => {
  notifyBuffering(true);
});

player.audio.addEventListener("playing", () => {
  notifyBuffering(false);
});

const onPlayProgress = () => {
  const bufferProgress = player.audio.buffered.length
    ? player.audio.buffered.end(player.audio.buffered.length - 1) /
      player.audio.duration
    : 0;
  fireNativeCall(
    "audioplayer.onPlayProgress",
    player.currentId,
    player.audio.currentTime,
    bufferProgress
  );
};
player.audio.addEventListener("timeupdate", onPlayProgress);
player.audio.addEventListener("progress", onPlayProgress);

// Forward playback time to main process for the desktop lyrics window
player.audio.addEventListener("timeupdate", () => {
  ipcRenderer.send("desktopLyrics.timeUpdate", player.audio.currentTime * 1000);
});

// Forward lyric style updates to main process for the desktop lyrics window
player.addEventListener("lyricstyleupdate", () => {
  ipcRenderer.send("desktopLyrics.styleUpdate", { ...player.lyricStyle });
});

// Forward lyric content updates to main process for the desktop lyrics window
player.addEventListener("lyriccontentupdate", (event) => {
  const content = (event as CustomEvent<LyricContent | null>).detail;
  ipcRenderer.send("desktopLyrics.lyricsUpdate", content);
});

player.audio.addEventListener("volumechange", () => {
  fireNativeCall(
    "audioplayer.onVolume",
    player.currentId,
    "",
    0,
    player.audio.volume
  );
});

navigator.mediaSession.setActionHandler("nexttrack", () => {
  fireNativeCall("winhelper.onHotkey", "next_1", true);
});
navigator.mediaSession.setActionHandler("previoustrack", () => {
  fireNativeCall("winhelper.onHotkey", "prev_1", true);
});
navigator.mediaSession.setActionHandler("stop", () => {
  fireNativeCall("winhelper.onHotkey", "stop", true);
});
["play", "pause"].forEach((action: MediaSessionAction) => {
  navigator.mediaSession.setActionHandler(action, () => {
    fireNativeCall("winhelper.onHotkey", "play_pause_3", true);
  });
});
