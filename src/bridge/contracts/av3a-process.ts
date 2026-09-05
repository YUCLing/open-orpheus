import type { Av3aPcmEvent, Av3aTrackInfo } from "./av3a-api";

/**
 * Messaging between the main process and the AV3A decode utility process
 * (`process.parentPort` <-> `UtilityProcess.postMessage`).
 */

/** main -> utility process */
export type Av3aProcessMainToService =
  | { type: "init"; path: string; totalLength: number; prefixEnd: number }
  | { type: "frontier"; prefixEnd: number }
  | { type: "rangeReady"; id: number; prefixEnd: number }
  | { type: "rangeError"; id: number; message: string };

/** utility process -> main (main only serves byte ranges; nothing else). */
export type Av3aProcessServiceToMain = {
  type: "ensureRange";
  id: number;
  start: number;
  end: number;
};

/**
 * Direct channel (a `MessageChannelMain` end in each process) between the
 * renderer and the AV3A decode utility process. Every decode event — opened,
 * PCM frames, done, errors — plus flow control and seeks travels here, in
 * order, without main on the path. That keeps playback flowing while main is
 * busy (e.g. blocked by a window drag).
 */
export type Av3aChannelRendererToService =
  { type: "pause" } | { type: "resume" } | { type: "seek"; frameIndex: number };

export type Av3aChannelServiceToRenderer =
  | ({ type: "pcm" } & Av3aPcmEvent)
  | { type: "opened"; info: Av3aTrackInfo }
  | { type: "done" }
  | { type: "error"; message: string };
