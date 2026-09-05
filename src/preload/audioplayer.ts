import { ipcRenderer } from "electron";
import { fireNativeCall } from "./channel";
import Player, { AudioPlayerState } from "./Player";
import { toError } from "../util";

export const PLAYING_EVENTS = ["play", "playing"] as const;
export const HALTED_EVENTS = ["pause", "stalled", "ended", "error"] as const;

export const player = new Player();

ipcRenderer.invoke("audio.getDevice").then((deviceId) => {
  if (deviceId && typeof deviceId === "string") {
    (player.audioContext as unknown as HTMLAudioElement)
      .setSinkId(deviceId)
      .catch((e) => {
        LOGGER.error({ err: toError(e) }, `Failed to set audio output device`);
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
  // Playback's stopped, it's replacing, tell main process
  ipcRenderer.send("player.timeupdate", null);
  await ipcRenderer.invoke("audio.updatePlayInfo", event.data);
});

player.on("load", (event) => {
  // Playback's ready, tell main process.
  ipcRenderer.send("player.timeupdate", 0);
  const { id } = event.data;
  bufferProgress = 0;
  fireNativeCall("audioplayer.onLoad", id, {
    activeCode: 0,
    code: 0,
    duration: player.duration || 0,
    errorCode: 0,
    errorString: "",
    openWholeCached: true,
    preloadWholeCached: false,
  });
});

player.on("play", () => {
  // 1806160891_1B5MK7|resume|XEDKE2
  // 1806160891|pause|4RB6IY
  fireNativeCall(
    "audioplayer.onPlayState",
    player.currentId,
    "",
    AudioPlayerState.Playing
  );
});

player.on("pause", () => {
  fireNativeCall(
    "audioplayer.onPlayState",
    player.currentId,
    "",
    AudioPlayerState.Paused
  );
});

player.on("ended", () => {
  fireNativeCall("audioplayer.onEnd", player.currentId, {
    activeCode: 0,
    code: 0,
    errorCode: 0,
    errorString: "",
    playedAudioTime: player.duration * 1000 || 0,
    playedTime: player.duration * 1000 || 0,
  });
});

player.on("error", async ({ data }) => {
  const id = player.currentId;
  const playInfo = player.currentPlayInfo;
  try {
    if (data instanceof Error) {
      // Decode error from the AV3A path.
      throw data;
    }
    if (playInfo?.type === 4) {
      const [res] = await ipcRenderer.invoke("channel.call", "network.fetch", {
        url: playInfo.musicurl,
        method: "HEAD",
        retryCount: 3,
      });
      if (player.currentId !== id) return; // Check if the current audio has changed
      if (res.status === 403) {
        fireNativeCall("audioplayer.onrequestrefreshsongurl", playInfo);
      } else {
        // Not because of the expired link
        throw new Error("Audio playback failed");
      }
    }
  } catch {
    if (player.currentId !== id) return; // Check if the current audio has changed
    fireNativeCall("audioplayer.onEnd", id, {
      activeCode: 6,
      code: 2,
      errorCode: 3,
      errorString: "",
      playedAudioTime: player.currentTime * 1000 || 0,
      playedTime: player.currentTime * 1000 || 0,
    });
  }
});

player.on("seeked", () => {
  fireNativeCall(
    "audioplayer.onSeek",
    player.currentId,
    "",
    0,
    player.currentTime
  );
  notifyBuffering(true);
});

player.on("stalled", () => {
  notifyBuffering(true);
});

player.on("playing", () => {
  notifyBuffering(false);
});

const onPlayProgress = () => {
  fireNativeCall(
    "audioplayer.onPlayProgress",
    player.currentId,
    player.currentTime,
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
PLAYING_EVENTS.forEach((e) => player.on(e, startProgressRaf));
HALTED_EVENTS.forEach((e) => player.on(e, stopProgressRaf));
ipcRenderer.on("audio.onProgress", (event, progress) => {
  bufferProgress = progress;
  onPlayProgress();
});

player.on("volumechange", (event) => {
  fireNativeCall("audioplayer.onVolume", player.currentId, "", 0, event.data);
  ipcRenderer.send("player.volumechange", event.data);
});

player.on("audiodata", (event) => {
  const { data, pts } = event.data;
  fireNativeCall("audioplayer.onAudioData", { data, pts });
});

player.on("ratechange", () => {
  ipcRenderer.send("player.playbackratechange", player.playbackRate);
});

const PLAYBACK_CHANGE = {
  PLAYING: "playing",
  PAUSED: "paused",
  STOPPED: "stopped",
  STALLED: "stalled",
  SEEKING: "seeking",
} as const;

// Single playback-transition channel for the main process. `stalled` and
// `seeking` are transient: media-session status keeps its previous value, while
// lyrics still learns progress stopped via the controller's derived boolean.
PLAYING_EVENTS.forEach((e) =>
  player.on(e, () => {
    ipcRenderer.send("player.playbackchange", PLAYBACK_CHANGE.PLAYING);
  })
);
player.on("pause", () => {
  ipcRenderer.send(
    "player.playbackchange",
    player.currentPlayInfo ? PLAYBACK_CHANGE.PAUSED : PLAYBACK_CHANGE.STOPPED
  );
});
player.on("ended", () => {
  ipcRenderer.send("player.playbackchange", PLAYBACK_CHANGE.STOPPED);
});
player.on("error", () => {
  ipcRenderer.send("player.playbackchange", PLAYBACK_CHANGE.STOPPED);
});
player.on("stalled", () => {
  ipcRenderer.send("player.playbackchange", PLAYBACK_CHANGE.STALLED);
});
player.on("seeking", () => {
  ipcRenderer.send("player.playbackchange", PLAYBACK_CHANGE.SEEKING);
});

player.on("seeked", () =>
  ipcRenderer.send("player.seeked", player.currentTime)
);
player.on("timeupdate", () =>
  ipcRenderer.send("player.timeupdate", player.currentTime)
);
player.on("durationchange", () => {
  let duration: number | null = player.duration;
  if (!isFinite(duration) || duration < 0) duration = null;
  ipcRenderer.send("player.durationchange", duration);
});

ipcRenderer.on("player.seek", (e, delta) => {
  player.currentTime += delta;
});

ipcRenderer.on("player.seekto", (e, position) => {
  player.currentTime = position;
});

ipcRenderer.on("player.volume", (e, volume) => {
  player.volume = volume;
});
