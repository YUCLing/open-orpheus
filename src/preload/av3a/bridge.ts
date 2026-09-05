import { ipcRenderer } from "electron";

import type { AudioPlayInfo } from "../Player";
import type { Av3aContract } from "../../bridge/contracts/av3a-api";

/**
 * Typed client for the main-process `av3a` bridge (the player window).
 *
 * Mirrors `Av3aContract` on top of `ipcRenderer`: methods become
 * `ipcRenderer.invoke("av3a.<method>", ...)`, events become
 * `ipcRenderer.on("av3a.<event>", ...)`.
 *
 * Decode events/frames + pause/resume/seek are NOT here — they use the direct
 * renderer <-> decode-utility channel (`av3aChannel`).
 */
export const av3aBridge = {
  start(playInfo: AudioPlayInfo): Promise<void> {
    return ipcRenderer.invoke("av3a.start", playInfo) as Promise<void>;
  },
  stop(): Promise<void> {
    return ipcRenderer.invoke("av3a.stop") as Promise<void>;
  },
  /** Fallback terminal errors originating in main (e.g. process crash). */
  onError(callback: (message: string) => void): void {
    ipcRenderer.on("av3a.error", (_event, message: string) =>
      callback(message)
    );
  },
  onProgress(callback: (loaded: number, total: number) => void): void {
    ipcRenderer.on("av3a.progress", (_event, loaded: number, total: number) =>
      callback(loaded, total)
    );
  },
};

export type Av3aBridge = typeof av3aBridge;
export type { Av3aContract };
