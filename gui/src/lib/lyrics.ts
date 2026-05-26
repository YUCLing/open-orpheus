import type { LyricsContract } from "$bridge/contracts/lyrics-api";
import type { LyricsStore } from "$sharedTypes/lyrics";

import { getBridge } from "./bridge";

const eventTarget = new EventTarget();

const api = getBridge<LyricsContract>("lyrics");

let lyricStore: LyricsStore | null = null;
let slogan: string | null = null;
let playState = false;
let time = 0;

let lastTimeUpdate: number | null = null;

api.events.lyricsStoreUpdate((store) => {
  lyricStore = store;
  eventTarget.dispatchEvent(new CustomEvent("lyricsupdate", { detail: store }));
});
api.events.sloganUpdate((newSlogan) => {
  slogan = newSlogan;
  eventTarget.dispatchEvent(
    new CustomEvent("sloganupdate", { detail: newSlogan })
  );
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
    time += diff / 1000;
    // Clears the lastTimeUpdate to ensure it won't get applied when it restarts
    lastTimeUpdate = null;
  }
  eventTarget.dispatchEvent(
    new CustomEvent("playstateupdate", { detail: state })
  );
});
api.events.timeUpdate((newTime) => {
  lastTimeUpdate = performance.now();
  time = newTime;
  eventTarget.dispatchEvent(new CustomEvent("timeupdate", { detail: newTime }));
});

api.requestFullUpdate();

export type RAFEvent = CustomEvent<{
  time: number;
  playState: boolean;
}>;

export default class LyricsSynchronizer extends EventTarget {
  private static readonly forwardedEvents = [
    "lyricsupdate",
    "sloganupdate",
    "playstateupdate",
    "timeupdate",
  ];

  get lyrics() {
    return lyricStore;
  }

  get slogan() {
    return slogan;
  }

  get playState() {
    return playState;
  }

  get time() {
    // When paused, stopped or we don't have last update data,
    // we simple return the latest time available
    if (!playState || !lastTimeUpdate) return time;
    const diff = performance.now() - lastTimeUpdate;
    return time + diff / 1000;
  }

  private rafId: number | null = null;
  private rafListeners = 0;

  constructor() {
    super();

    this.onRAF = this.onRAF.bind(this);
  }

  addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean
  ): void {
    if (LyricsSynchronizer.forwardedEvents.includes(type)) {
      eventTarget.addEventListener(type, callback, options);
      return;
    }
    super.addEventListener(type, callback, options);
    if (type === "raf") {
      this.rafListeners++;
      this.setRAFEnabled(true);
    }
  }

  removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean
  ): void {
    if (LyricsSynchronizer.forwardedEvents.includes(type)) {
      eventTarget.removeEventListener(type, callback, options);
      return;
    }
    super.removeEventListener(type, callback, options);
    if (type === "raf") this.rafListeners--;
    if (this.rafListeners === 0) this.setRAFEnabled(false);
  }

  private onRAF() {
    this.rafId = requestAnimationFrame(this.onRAF);
    this.dispatchEvent(
      new CustomEvent("raf", {
        detail: {
          time: this.time,
          playState: this.playState,
        },
      })
    );
  }

  private setRAFEnabled(enabled: boolean) {
    if (this.rafId !== null) {
      // Stop the previous rAF regardless enabled or not.
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (!enabled) return;
    // Start rAF
    this.rafId = requestAnimationFrame(this.onRAF);
  }
}
