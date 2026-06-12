import { ipcRenderer } from "electron";
import { fireNativeCall } from "./channel";
import Player, { AudioPlayerState } from "./Player";

const PLAYING_EVENTS = ["play", "playing"];
const HALTED_EVENTS = ["pause", "stalled", "ended", "error"];

export const player = new Player();

ipcRenderer.invoke("audio.getDevice").then((deviceId) => {
  if (deviceId && typeof deviceId === "string") {
    (player.audioContext as unknown as HTMLAudioElement)
      .setSinkId(deviceId)
      .catch((e) => {
        console.error("Failed to set audio output device:", e);
      });
  }
});

let buffering = false;
let bufferProgress = 0;

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

player.on("playinfoupdate", async (event) => {
  await ipcRenderer.invoke("audio.updatePlayInfo", event.data);
});

player.on("load", (event) => {
  const { id } = event.data;
  bufferProgress = 0;
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
  fireNativeCall(
    "audioplayer.onPlayProgress",
    player.currentId,
    player.audio.currentTime,
    bufferProgress
  );
};
// NCM expects onPlayProgress to be called as fast as possible during playback
let rafId: number | null = null;
function startProgressRaf() {
  if (rafId !== null) return;
  const loop = () => {
    onPlayProgress();
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}
function stopProgressRaf() {
  if (rafId === null) return;
  cancelAnimationFrame(rafId);
  rafId = null;
}
PLAYING_EVENTS.forEach((e) =>
  player.audio.addEventListener(e, startProgressRaf)
);
HALTED_EVENTS.forEach((e) => player.audio.addEventListener(e, stopProgressRaf));
ipcRenderer.on("audio.onProgress", (event, progress) => {
  bufferProgress = progress;
  onPlayProgress();
});

player.on("volumechange", (event) => {
  fireNativeCall("audioplayer.onVolume", player.currentId, "", 0, event.data);
});

player.on("audiodata", (event) => {
  const { data, pts } = event.data;
  fireNativeCall("audioplayer.onAudioData", { data, pts });
});

function updatePositionState() {
  const duration = player.audio.duration;
  if (!isFinite(duration) || duration < 0) return;
  navigator.mediaSession.setPositionState({
    duration,
    position: Math.min(player.audio.currentTime, duration),
    playbackRate: player.audio.playbackRate,
  });
}

navigator.mediaSession.playbackState = "paused";

PLAYING_EVENTS.forEach((e) =>
  player.audio.addEventListener(e, () => {
    navigator.mediaSession.playbackState = "playing";
    updatePositionState();
  })
);
[...HALTED_EVENTS, "seeking"].forEach((e) =>
  player.audio.addEventListener(e, () => {
    navigator.mediaSession.playbackState = "paused";
    updatePositionState();
  })
);

player.audio.addEventListener("seeked", updatePositionState);

navigator.mediaSession.setActionHandler("nexttrack", () => {
  fireNativeCall("winhelper.onHotkey", "next_1", true);
});
navigator.mediaSession.setActionHandler("previoustrack", () => {
  fireNativeCall("winhelper.onHotkey", "prev_1", true);
});
navigator.mediaSession.setActionHandler("seekto", ({ seekTime }) => {
  if (isNaN(Number(seekTime))) return;
  player.audio.currentTime = seekTime as number;
});
navigator.mediaSession.setActionHandler("seekforward", ({ seekOffset }) => {
  const offset = seekOffset ?? 10;
  player.audio.currentTime += offset;
});
navigator.mediaSession.setActionHandler("seekbackward", ({ seekOffset }) => {
  const offset = seekOffset ?? 10;
  player.audio.currentTime -= offset;
});
navigator.mediaSession.setActionHandler("stop", () => {
  fireNativeCall("winhelper.onHotkey", "stop", true);
});
(["play", "pause"] as MediaSessionAction[]).forEach(
  (action: MediaSessionAction) => {
    navigator.mediaSession.setActionHandler(action, () => {
      fireNativeCall("winhelper.onHotkey", "play_pause_3", true);
    });
  }
);
