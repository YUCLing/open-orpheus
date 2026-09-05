import type { AudioPlayInfo } from "../../preload/Player";

/** Track metadata reported once the AV3A track has been indexed (`moov`). */
export interface Av3aTrackInfo {
  sampleRate: number;
  channels: number;
  frameCount: number;
  durationSeconds: number;
  mediaStart: number;
  mediaEnd: number;
}

/** One decoded PCM16 frame. */
export interface Av3aPcmEvent {
  /** Interleaved little-endian PCM16 (`channels * 1024` samples). */
  data: ArrayBuffer;
  /** 0-based AV3A frame index within the track. */
  frameIndex: number;
  sampleRate: number;
  channels: number;
  /** Presentation timestamp in milliseconds. */
  pts: number;
}

/**
 * Control-plane bridge between the player window and main's AV3A playback
 * manager (which forks the decode utility process).
 *
 * `events.*` are pushed from main via `webContents.send("av3a.<event>", ...)`;
 * the remaining methods are invoked by the player via
 * `ipcRenderer.invoke("av3a.<method>", ...)`.
 *
 * Decode events (`opened`/`pcm`/`done`/`error`), frames, and flow control
 * (`pause`/`resume`/`seek`) are intentionally NOT here: they travel on the
 * direct renderer<->decode-utility channel (see `av3a-process.ts`), keeping
 * the main process off the real-time path. Main's `error` event is kept as a
 * fallback for terminal, main-originated failures (e.g. the decode process
 * crashing).
 */
export interface Av3aContract {
  events: {
    error(callback: (message: string) => void): void;
    /** Download progress of the encoded source. */
    progress(callback: (loaded: number, total: number) => void): void;
  };
  /**
   * Start decoding `playInfo` in the AV3A decode utility process.
   * Currently supports URL playback (`type === 4`, `audioFormat === "av3a"`).
   */
  start(playInfo: AudioPlayInfo): Promise<void>;
  /** Stop decoding: tear down the utility process and the underlying streamer. */
  stop(): Promise<void>;
}
