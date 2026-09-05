/**
 * Shared AV3A decode types + executor contract used by the decode session
 * (`Av3aM4aSession`) and its transport. The transport may be anything that
 * exposes the same async surface (a worker-thread RPC, direct native calls in
 * a utility process, ...); the session only depends on this interface.
 */

// `Av3aTrackInfo` has a single home in the bridge contracts (it is the `opened`
// wire payload too); import + re-export it here so decode-core code keeps one
// import. Both are type-only, so nothing leaks into the utility-process bundle.
import type { Av3aTrackInfo } from "../../bridge/contracts/av3a-api";

export type { Av3aTrackInfo };

/** Byte range of the next sample (`done: true` at the end of the track). */
export type Av3aSampleRange = {
  done: boolean;
  start: number;
  end: number;
};

/** One decoded frame; `data` is little-endian PCM16 (zero-copy where possible). */
export type Av3aDecodedFrame =
  | {
      done: true;
      frameIndex: number;
      sampleRate: 0;
      channels: 0;
      data: null;
    }
  | {
      done: false;
      frameIndex: number;
      sampleRate: number;
      channels: number;
      data: ArrayBuffer;
    };

/**
 * The asynchronous decode surface the session paces against.
 *
 * Implementations may talk to a native decoder directly or proxy it through a
 * process boundary; the session treats every call as async so a transport can
 * yield between native calls.
 */
export interface Av3aDecodeExecutor {
  /** Open an M4A/MP4 file and index its AV3A track. Throws when not ready. */
  open(path: string): Promise<void>;
  /** Track information for the opened file. */
  info(): Promise<Av3aTrackInfo>;
  /** Move to an exact track frame (warm-up frames handled internally). */
  seekToFrame(frameIndex: number): Promise<void>;
  /** Byte range of the sample the next `decodeNext` reads. */
  nextSampleRange(): Promise<Av3aSampleRange>;
  /**
   * Byte range the next `decodeNext` reads (after a seek this also spans the
   * warm-up frames the decoder fast-forwards through).
   */
  decodeWindowRange(): Promise<Av3aSampleRange>;
  /** Decode the next frame. */
  decodeNext(): Promise<Av3aDecodedFrame>;
  /** Release the underlying file handle. */
  close(): Promise<void>;
}
