import { ipcRenderer } from "electron";
import { fireNativeCall } from "./channel";
import Player, { AudioPlayerState } from "./Player";

import { get as kvGet } from "../storage";
import {
  IPC,
  LISTEN_TOGETHER_REMOTE_PAUSE_SUPPRESS_MS,
  LISTEN_TOGETHER_PLAY_SUPPRESS_MS,
  LISTEN_TOGETHER_PROGRESS_SYNC_THRESHOLD,
  LISTEN_TOGETHER_PROGRESS_COOLDOWN_MS,
  LISTEN_TOGETHER_REMOTE_CHANGE_SUPPRESS_MS,
} from "../shared/listenTogetherConstants";

export const player = new Player();

kvGet("audioplayer.currentAudioOutputDevice").then((deviceId) => {
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
let lastReportedSongId = "";
let suppressListenTogetherReportUntil = 0;
let suppressListenTogetherReportSongId = "";
let suppressListenTogetherPlayUntil = 0;
let suppressListenTogetherPlaySongId = "";
let applyingRemoteCommand = false;
let lastProgressSyncTime = 0;

export type ListenTogetherRemoteCommand = {
  commandType?: string;
  playStatus?: string;
  progress?: number;
  formerSongId?: string;
  targetSongId?: string;
  songId?: string;
};

export function suppressListenTogetherPlaybackResume(songId: string) {
  suppressListenTogetherReportUntil = Date.now() + LISTEN_TOGETHER_REMOTE_PAUSE_SUPPRESS_MS;
  suppressListenTogetherReportSongId = songId;
  suppressListenTogetherPlayUntil = suppressListenTogetherReportUntil;
  suppressListenTogetherPlaySongId = songId;
}

export function suppressListenTogetherRemoteChangeEcho(songId: string) {
  suppressListenTogetherReportUntil = Date.now() + LISTEN_TOGETHER_REMOTE_CHANGE_SUPPRESS_MS;
  suppressListenTogetherReportSongId = songId;
}

function getListenTogetherSongId() {
  return player.currentId.split("_", 1)[0] || player.currentId;
}

function reportListenTogetherPlayCommand(commandType: string, playStatus: string) {
  if (applyingRemoteCommand) {
    console.log("[LT:PRELOAD] suppress echo from remote command application", commandType, playStatus);
    return;
  }
  const songId = getListenTogetherSongId();
  if (
    Date.now() < suppressListenTogetherReportUntil &&
    (!suppressListenTogetherReportSongId || suppressListenTogetherReportSongId === songId)
  ) {
    console.log("[LT:PRELOAD] suppress native echo", commandType, playStatus);
    return;
  }

  if (!songId) return;

  console.log("[LT:PRELOAD] reportListenTogetherPlayCommand", commandType, playStatus, "song:", songId);
  lastReportedSongId = songId;

  ipcRenderer.send(IPC.LT_NATIVE_PLAY_COMMAND, {
    commandType,
    playStatus,
    progress: Math.round(player.audio.currentTime * 1000),
    formerSongId: songId,
    targetSongId: songId,
  });
}

function normalizeListenTogetherToken(value: string | undefined) {
  return value?.trim().toUpperCase() ?? "";
}

function getRemoteSongId(commandInfo: ListenTogetherRemoteCommand) {
  return commandInfo.targetSongId || commandInfo.songId || commandInfo.formerSongId || "";
}

export async function applyRemoteListenTogetherCommand(
  commandInfo: ListenTogetherRemoteCommand
) {
  const currentSongId = getListenTogetherSongId();
  const remoteSongId = getRemoteSongId(commandInfo);
  if (remoteSongId && currentSongId && remoteSongId !== currentSongId) {
    suppressListenTogetherRemoteChangeEcho(remoteSongId);
    console.log(
      "[LT:PRELOAD] remote command targets another song, skipping direct audio sync:",
      currentSongId,
      "->",
      remoteSongId
    );
    return false;
  }

  const commandType = normalizeListenTogetherToken(commandInfo.commandType);
  const playStatus = normalizeListenTogetherToken(commandInfo.playStatus);
  const progress = commandInfo.progress;
  const shouldPause = playStatus === "PAUSE" || commandType === "PAUSE";

  applyingRemoteCommand = true;
  try {
    if (shouldPause) {
      suppressListenTogetherPlaybackResume(remoteSongId || currentSongId);
    } else {
      suppressListenTogetherReportUntil = Date.now() + LISTEN_TOGETHER_PLAY_SUPPRESS_MS;
      suppressListenTogetherReportSongId = remoteSongId || currentSongId;
    }
    const shouldPlay =
      !shouldPause &&
      (playStatus === "PLAY" || commandType === "PLAY" || commandType === "PROGRESS" || commandType === "GOTO");

    if (typeof progress === "number" && Number.isFinite(progress) && progress >= 0) {
      const now = Date.now();
      if (now - lastProgressSyncTime >= LISTEN_TOGETHER_PROGRESS_COOLDOWN_MS) {
        const nextTime = progress > 1000 ? progress / 1000 : progress;
        if (Math.abs(player.audio.currentTime - nextTime) > LISTEN_TOGETHER_PROGRESS_SYNC_THRESHOLD) {
          player.audio.currentTime = nextTime;
          lastProgressSyncTime = now;
        }
      }
    }

    if (shouldPause) {
      player.audio.pause();
      return true;
    }

    if (shouldPlay) {
      if (player.audio.paused) await player.audio.play();
      return true;
    }

    return true;
  } finally {
    applyingRemoteCommand = false;
  }
}

ipcRenderer.on(
  IPC.LT_APPLY_REMOTE_PLAY_COMMAND,
  (_event, commandInfo: ListenTogetherRemoteCommand) => {
    applyRemoteListenTogetherCommand(commandInfo).catch((error) => {
      console.warn("[LT:PRELOAD] remote command failed:", error);
    });
  }
);

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

player.addEventListener("playinfoupdate", () => {
  ipcRenderer.sendSync("audio.updatePlayInfo", player.currentPlayInfo);
});

player.addEventListener("load", (event) => {
  const { id } = (event as CustomEvent).detail;
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
  const songId = getListenTogetherSongId();
  if (
    Date.now() < suppressListenTogetherPlayUntil &&
    (!suppressListenTogetherPlaySongId || suppressListenTogetherPlaySongId === songId)
  ) {
    console.log("[LT:PRELOAD] suppress remote pause resume", songId);
    player.audio.pause();
    return;
  }

  fireNativeCall(
    "audioplayer.onPlayState",
    player.currentId,
    "",
    AudioPlayerState.Playing
  );
  if (lastReportedSongId && lastReportedSongId !== songId) {
    if (
      Date.now() < suppressListenTogetherReportUntil &&
      (!suppressListenTogetherReportSongId || suppressListenTogetherReportSongId === songId)
    ) {
      console.log("[LT:PRELOAD] suppress native song-switch echo", lastReportedSongId, "->", songId);
      lastReportedSongId = songId;
      return;
    }

    console.log("[LT:PRELOAD] song switch detected:", lastReportedSongId, "->", songId);
    ipcRenderer.send(IPC.LT_NATIVE_PLAY_COMMAND, {
      commandType: "NEXT",
      playStatus: "PLAY",
      progress: 0,
      formerSongId: lastReportedSongId,
      targetSongId: songId,
    });
  } else {
    reportListenTogetherPlayCommand("PLAY", "PLAY");
  }
  lastReportedSongId = songId;
});

player.audio.addEventListener("pause", () => {
  fireNativeCall(
    "audioplayer.onPlayState",
    player.currentId,
    "",
    AudioPlayerState.Paused
  );
  reportListenTogetherPlayCommand("PAUSE", "PAUSE");
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
  reportListenTogetherPlayCommand(
    "PROGRESS",
    player.audio.paused ? "PAUSE" : "PLAY"
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
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}
["play", "playing"].forEach((e) =>
  player.audio.addEventListener(e, startProgressRaf)
);
["pause", "stalled", "ended", "error"].forEach((e) =>
  player.audio.addEventListener(e, stopProgressRaf)
);
ipcRenderer.on("audio.onProgress", (event, progress) => {
  bufferProgress = progress;
  onPlayProgress();
});

player.addEventListener("volumechange", () => {
  fireNativeCall(
    "audioplayer.onVolume",
    player.currentId,
    "",
    0,
    player.volume
  );
});

player.addEventListener("audiodata", (event) => {
  const { data, pts } = (event as CustomEvent).detail;
  fireNativeCall("audioplayer.onAudioData", { data, pts });
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
(["play", "pause"] as MediaSessionAction[]).forEach(
  (action: MediaSessionAction) => {
    navigator.mediaSession.setActionHandler(action, () => {
      fireNativeCall("winhelper.onHotkey", "play_pause_3", true);
    });
  }
);
