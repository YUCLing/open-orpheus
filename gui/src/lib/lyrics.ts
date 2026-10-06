import Emittery from "emittery";

import type { LyricsContract } from "$bridge/contracts/lyrics-api";
import type { LyricsStore } from "@shared/types/lyrics";

import { getBridge } from "./bridge";

export type LyricsBridgeEvents = {
  lyricsupdate: LyricsStore | null;
  sloganupdate: string | null;
  playstateupdate: boolean;
  timeupdate: number;
  raf: { time: number; playState: boolean; playbackRate: number };
};

const emitter = new Emittery<LyricsBridgeEvents>();
export const lyricsBridgeEmitter = emitter;

emitter.init("raf", () => {
  setRAFEnabled(true);

  return () => setRAFEnabled(false);
});

const api = getBridge<LyricsContract>("lyrics");

let lyrics: LyricsStore | null = null;
let slogan: string | null = null;
let playState = false;
let time = 0;
let playbackRate = 1;

let lastTimeUpdate: number | null = null;
let rafId: number | null = null;

api.events.lyricsStoreUpdate((store) => {
  lyrics = store;
  emitter.emit("lyricsupdate", store);
});
api.events.sloganUpdate((newSlogan) => {
  slogan = newSlogan;
  emitter.emit("sloganupdate", newSlogan);
});
api.events.playStateUpdate((state) => {
  playState = state;
  if (state) {
    // Ensure interpolation can continue before first timeupdate arrives
    if (!lastTimeUpdate) lastTimeUpdate = performance.now();
  } else {
    // Paused, stopped... or anything else, we simply make sure we are providing
    // the latest time available if timeupdate was not updated when it stops.
    const diff = lastTimeUpdate ? performance.now() - lastTimeUpdate : 0;
    time += (diff / 1000) * playbackRate;
    // Clears the lastTimeUpdate to ensure it won't get applied when it restarts
    lastTimeUpdate = null;
  }
  emitter.emit("playstateupdate", state);
});
api.events.timeUpdate((newTime) => {
  lastTimeUpdate = performance.now();
  time = newTime;
  emitter.emit("timeupdate", newTime);
});
api.events.playbackRateUpdate((rate) => {
  // Settle elapsed time at the old rate before switching,
  // so getTime() doesn't apply the new rate to the entire interval.
  if (playState && lastTimeUpdate) {
    const diff = performance.now() - lastTimeUpdate;
    time += (diff / 1000) * playbackRate;
    lastTimeUpdate = performance.now();
  }
  playbackRate = rate;
});

api.requestFullUpdate();

function onRAF() {
  rafId = requestAnimationFrame(onRAF);
  emitter.emit("raf", { time: getTime(), playState, playbackRate });
}

function setRAFEnabled(enabled: boolean) {
  if (rafId !== null) {
    // Stop the previous rAF regardless enabled or not.
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (!enabled) return;
  // Start rAF
  rafId = requestAnimationFrame(onRAF);
}

export function getLyrics() {
  return lyrics;
}

export function getSlogan() {
  return slogan;
}

export function getPlayState() {
  return playState;
}

export function getTime() {
  if (!playState || !lastTimeUpdate) return time;
  const diff = performance.now() - lastTimeUpdate;
  return time + (diff / 1000) * playbackRate;
}
