import type { PlaybackMode } from "$sharedTypes/playback-mode";

export interface PlaybackModeBridgeApi {
  reportMode(mode: PlaybackMode): void;
  onCommand(handler: (mode: PlaybackMode) => Promise<void>): void;
}

interface PlayingStore {
  getState(): { playing?: { playingMode?: unknown } };
  dispatch(action: { type: string; payload: { playingMode: PlaybackMode } }): unknown;
  subscribe(listener: () => void): () => void;
}

interface WebpackRequire {
  c: Record<string, { exports: unknown }>;
}

/**
 * Runs in the main world via contextBridge: keep all runtime dependencies inside
 * this function. Discover the initialized playing store by shape, without fixed
 * webpack module IDs, source rewrites, or invoking unloaded modules.
 */
export function installPlaybackModeBridge(api: PlaybackModeBridgeApi): void {
  let require: WebpackRequire | null = null;
  let queued = false;
  let unsubscribe: (() => void) | undefined;
  let previous: unknown;
  const deadline = Date.now() + 30_000;

  const connect = (): boolean => {
    const chunks = (window as unknown as { webpackJsonp?: unknown[] }).webpackJsonp;
    if (!queued && Array.isArray(chunks)) {
      queued = true;
      const id = "open-orpheus-playback-mode";
      // Orpheus uses webpack 4's JSONP runtime. A private, dependency-free
      // module captures its require handle when the runtime is ready.
      chunks.push([
        [id],
        {
          [id]: (_module: unknown, _exports: unknown, runtime: WebpackRequire) => {
            require = runtime;
          },
        },
        [[id]],
      ]);
    }
    if (!require) return false;

    let store: PlayingStore | undefined;
    for (const module of Object.values(require.c)) {
      const exports = module.exports;
      if (!exports || typeof exports !== "object") continue;
      for (const key of [null, ...Object.keys(exports)]) {
        try {
          const value = key === null ? exports : (exports as Record<string, unknown>)[key];
          const candidate = value as { app?: { _store?: PlayingStore } };
          const possible = candidate?.app?._store ?? (value as PlayingStore);
          if (
            typeof possible?.getState === "function" &&
            typeof possible.dispatch === "function" &&
            typeof possible.subscribe === "function" &&
            typeof possible.getState().playing?.playingMode === "string"
          ) {
            store = possible;
            break;
          }
        } catch {
          // Some cached exports are getters for modules not initialized yet.
        }
      }
      if (store) break;
    }
    if (!store) return false;

    const playingStore = store;
    const report = () => {
      const mode = playingStore.getState().playing?.playingMode;
      if (mode === previous) return;
      previous = mode;
      if (
        ["playOrder", "playCycle", "playOneCycle", "playRandom", "playAi", "playFm"].includes(
          mode as string
        )
      ) {
        api.reportMode(mode as PlaybackMode);
      }
    };
    unsubscribe = playingStore.subscribe(report);
    api.onCommand(async (mode) => {
      await playingStore.dispatch({
        type: "playing/switchPlayingMode",
        payload: { playingMode: mode },
      });
      report();
    });
    report();
    return true;
  };

  const timer = setInterval(() => {
    if (connect()) clearInterval(timer);
    else if (Date.now() >= deadline) {
      clearInterval(timer);
      console.warn("Open Orpheus: renderer playback-mode integration is unavailable");
    }
  }, 250);
  window.addEventListener(
    "pagehide",
    () => {
      clearInterval(timer);
      unsubscribe?.();
    },
    { once: true }
  );
}
