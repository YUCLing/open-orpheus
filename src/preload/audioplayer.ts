import { fireNativeCall } from "./channel";
import Player, { AudioPlayerState } from "./Player";

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

player.audio.addEventListener("timeupdate", () => {
  fireNativeCall(
    "audioplayer.onPlayProgress",
    player.currentId,
    player.audio.currentTime,
    1
  ); // last likely the playback rate
});
