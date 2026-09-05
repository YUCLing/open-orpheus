import { av3aBridge } from "./bridge";
import { av3aChannel } from "./channel";
import type { AudioPlayInfo } from "../Player";
import type { Av3aTrackInfo } from "../../bridge/contracts/av3a-api";

/**
 * Renders the AV3A decode stream inside the player window's AudioContext.
 *
 * Decoded PCM16 frames arrive on the direct channel from the AV3A decode
 * utility process (`av3aChannel`) — not through main — and this class converts
 * them to stereo Float32 and pushes them into the `av3a-player` AudioWorklet.
 * The worklet reports consumed frames back, giving an accurate `currentTime`
 * and letting us pause/resume the decode (over the same direct channel) when
 * the buffer grows or shrinks past watermarks. Because the decode + PCM path
 * bypasses main, playback keeps flowing even while main is busy (e.g. a window
 * drag on Windows blocking the main process).
 */
export interface Av3aPcmPlayerEvents {
  onOpened?: (info: Av3aTrackInfo) => void;
  onEnded?: () => void;
  onError?: (message: string) => void;
  onBuffering?: (buffering: boolean) => void;
}

const HIGH_WATER_SECONDS = 0.5;
const LOW_WATER_SECONDS = 0.15;
/** AVS3-P3 decodes 1024 samples per channel per frame. */
const FRAME_SAMPLES = 1024;

export class Av3aPcmPlayer {
  private readonly ctx: AudioContext;
  private readonly events: Av3aPcmPlayerEvents;
  private node: AudioWorkletNode | null = null;
  private active = false;
  private playing = false;
  private stopped = false;
  private flowPaused = false;
  private streamEnded = false;
  private endedEmitted = false;
  private buffering = false;
  /** Output rate = the shared AudioContext's sample rate. */
  private readonly outputRate: number;
  /** Source (decoded) sample rate; known once the track is opened. */
  private sourceRate = 0;
  /** Resamples decoded (e.g. 44.1k) PCM up to the context rate. */
  private resampler: StereoResampler | null = null;
  private durationSeconds = 0;
  private pushedFrames = 0;
  private consumedFrames = 0;
  private startToken = 0;
  /** Content time (seconds) playback started / last seeked to. */
  private baseTimeSeconds = 0;
  /** Frames with an index below this are stale (emitted before a seek). */
  private dropUntilFrame = 0;
  private playbackRate = 1;

  constructor(ctx: AudioContext, events: Av3aPcmPlayerEvents = {}) {
    this.ctx = ctx;
    this.outputRate = ctx.sampleRate || 48_000;
    this.events = events;
  }

  get isActive(): boolean {
    return this.active;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get currentTime(): number {
    return (
      this.baseTimeSeconds +
      (this.consumedFrames / this.outputRate) * this.playbackRate
    );
  }

  get duration(): number {
    return this.durationSeconds;
  }

  /** The worklet node; connect this into the effect chain / honeypot. */
  get sourceNode(): AudioWorkletNode | null {
    return this.node;
  }

  /**
   * Load the worklet and connect it to `destination`. Safe to call once per
   * `start()`/`stop()` cycle (re-attaches to the same node).
   */
  async attach(destination: AudioNode): Promise<void> {
    if (this.node) return;
    await this.ctx.audioWorklet.addModule("audio://worklet/av3a-player.js");
    const node = new AudioWorkletNode(this.ctx, "av3a-player", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.port.onmessage = (e: MessageEvent) => {
      this.onWorkletMessage(e.data);
    };
    node.connect(destination);
    this.node = node;
  }

  async start(playInfo: AudioPlayInfo): Promise<void> {
    const token = ++this.startToken;
    this.stopped = false;
    this.active = true;
    this.playing = false;
    this.flowPaused = false;
    this.streamEnded = false;
    this.endedEmitted = false;
    this.buffering = false;
    this.sourceRate = 0;
    this.resampler = null;
    this.baseTimeSeconds = 0;
    this.dropUntilFrame = 0;
    this.durationSeconds = 0;
    this.pushedFrames = 0;
    this.consumedFrames = 0;

    this.node?.port.postMessage({ type: "reset" });
    // A freshly loaded track must not play until the user presses play.
    this.setWorkletPlaying(false);

    if (!this.av3aEventBound) {
      this.bindEvents();
    }

    try {
      await av3aBridge.start(playInfo);
    } catch (error) {
      if (token !== this.startToken) return;
      this.active = false;
      this.events.onError?.(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  async stop(): Promise<void> {
    this.startToken += 1;
    this.stopped = true;
    this.active = false;
    this.playing = false;
    this.flowPaused = false;
    this.streamEnded = true;
    this.node?.port.postMessage({ type: "reset" });
    this.setWorkletPlaying(false);
    try {
      await av3aBridge.stop();
    } catch {
      // Ignore: the session may already have ended.
    }
  }

  async play(): Promise<void> {
    if (!this.active) return;
    this.playing = true;
    if (this.ctx.state !== "running") {
      await this.ctx.resume().catch(() => {});
    }
    // Resume consuming at the worklet. The shared AudioContext is only resumed
    // when it is genuinely not running; a normal pause no longer suspends it.
    this.setWorkletPlaying(true);
    this.evaluateFlow();
  }

  pause(): void {
    this.playing = false;
    // Pause at the worklet (render silence, stop consuming) instead of
    // suspending the shared AudioContext: other consumers on the same context
    // (audio effects, honeypot, …) keep running.
    this.setWorkletPlaying(false);
  }

  /** Mirror `playing` into the worklet so it stops consuming while paused. */
  private setWorkletPlaying(playing: boolean): void {
    this.node?.port.postMessage({
      type: playing ? "resume" : "pause",
    });
  }

  /**
   * Set the playback rate. The resampler step changes from the current
   * position onward; already-buffered audio finishes at the old tempo.
   */
  setPlaybackRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) return;
    if (rate === this.playbackRate) return;
    // Keep content time continuous across the change by rebasing the counters.
    // Preserve only the frames still queued in the worklet so the backpressure
    // accounting does not believe there is a multi-second backlog (which would
    // keep decode paused and stall playback until a seek resets it).
    const buffered = Math.max(0, this.pushedFrames - this.consumedFrames);
    this.baseTimeSeconds = this.currentTime;
    this.consumedFrames = 0;
    this.pushedFrames = buffered;
    this.playbackRate = rate;
    this.updateResamplerStep();
    this.evaluateFlow();
  }

  /**
   * Seek to a content time (seconds). Flushes buffered audio, resets the
   * resampler, and repositions the main-process decode to the target frame.
   */
  async seekTo(seconds: number): Promise<void> {
    // After a real stop the decode service is torn down; resuming requires a
    // fresh `load()`. A seek is also meaningless before anything was started.
    if (this.stopped) return;
    if (!this.active && !this.streamEnded) return;

    // Seeking after the track finished (EOF): the decode service restarts on
    // the seek, so clear the ended state and resume so the target section
    // produces PCM again (previously it stalled in silence).
    if (this.streamEnded) {
      this.streamEnded = false;
    }
    if (!this.active) {
      this.active = true;
      this.endedEmitted = false;
      this.playing = true;
    }

    const sec = Number.isFinite(seconds)
      ? Math.max(0, Math.min(seconds, this.duration || seconds))
      : 0;
    const targetFrame =
      this.sourceRate > 0
        ? Math.round((sec * this.sourceRate) / FRAME_SAMPLES)
        : 0;
    this.baseTimeSeconds = sec;
    this.dropUntilFrame = Math.max(0, targetFrame);
    this.consumedFrames = 0;
    this.pushedFrames = 0;
    this.buffering = false;
    this.resampler?.reset();
    this.node?.port.postMessage({ type: "reset" });
    // Preserve the play/pause state across the flush (a seek while paused must
    // not start consuming before the user presses play).
    this.setWorkletPlaying(this.playing);
    try {
      await av3aChannel.seek(targetFrame);
      av3aChannel.resume();
    } catch {
      // Ignore: a seek racing a session teardown is not fatal.
    }
    this.evaluateFlow();
  }

  /** (Re)build or update the resampler for the current source/output/rate. */
  private updateResamplerStep(): void {
    if (this.sourceRate <= 0) return;
    const needsResample =
      this.sourceRate !== this.outputRate || this.playbackRate !== 1;
    if (!needsResample) {
      this.resampler = null;
      return;
    }
    if (!this.resampler) {
      this.resampler = new StereoResampler(this.sourceRate, this.outputRate);
    }
    this.resampler.setStep(
      (this.playbackRate * this.sourceRate) / this.outputRate
    );
  }

  // #region channel events

  private av3aEventBound = false;

  private bindEvents(): void {
    if (this.av3aEventBound) return;
    this.av3aEventBound = true;

    // All decode events arrive on the direct channel from the decode utility
    // process, in order (opened before any pcm). Main is not on this path, so
    // a busy main process can't stall playback.
    av3aChannel.onOpened((info) => {
      this.sourceRate = info.sampleRate || this.sourceRate;
      this.durationSeconds = info.durationSeconds;
      this.updateResamplerStep();
      this.events.onOpened?.(info);
    });

    av3aChannel.onPcm((frame) => {
      if (!this.active) return;
      // Drop frames that were decoded before the most recent seek target.
      if (frame.frameIndex < this.dropUntilFrame) {
        return;
      }
      if (this.buffering) {
        this.buffering = false;
        this.events.onBuffering?.(false);
      }
      this.pushFrame(frame);
      this.evaluateFlow();
    });

    av3aChannel.onDone(() => {
      this.streamEnded = true;
      this.maybeEmitEnded();
    });

    av3aChannel.onError((message) => {
      if (!this.active) return;
      this.events.onError?.(message);
    });

    // Fallback: terminal failures that originate in main (e.g. the decode
    // utility process crashing), which never reach the channel.
    av3aBridge.onError((message) => {
      if (!this.active) return;
      this.events.onError?.(message);
    });
  }

  // #endregion

  // #region worklet consumption

  private onWorkletMessage(msg: unknown): void {
    const data = msg as { type?: string; frames?: number };
    if (!data) return;
    if (data.type !== "consumed" || typeof data.frames !== "number") return;

    this.consumedFrames += data.frames;

    if (
      this.playing &&
      !this.streamEnded &&
      this.pushedFrames - this.consumedFrames <= 0
    ) {
      // Worklet ran dry while we still expect more PCM.
      if (!this.buffering) {
        this.buffering = true;
        this.events.onBuffering?.(true);
      }
    }

    this.maybeEmitEnded();
    this.evaluateFlow();
  }

  // #endregion

  // #region flow control + ended detection

  private queuedSeconds(): number {
    return (this.pushedFrames - this.consumedFrames) / this.outputRate;
  }

  private evaluateFlow(): void {
    if (!this.active) return;
    const queued = this.queuedSeconds();

    // Pause the decode once enough is buffered (also before the user presses
    // play, so a track never decodes the whole file into memory while idle).
    if (!this.flowPaused && queued >= HIGH_WATER_SECONDS) {
      this.flowPaused = true;
      av3aChannel.pause();
    } else if (this.flowPaused && this.playing && queued <= LOW_WATER_SECONDS) {
      this.flowPaused = false;
      av3aChannel.resume();
    }
  }

  private maybeEmitEnded(): void {
    if (
      this.streamEnded &&
      !this.endedEmitted &&
      this.pushedFrames - this.consumedFrames <= 0
    ) {
      this.endedEmitted = true;
      this.active = false;
      this.playing = false;
      this.events.onEnded?.();
    }
  }

  // #endregion

  // #region PCM conversion

  private pushFrame(frame: {
    data: ArrayBuffer;
    channels: number;
    frameIndex: number;
  }): void {
    const node = this.node;
    if (!node) return;
    const stereo = pcm16ToStereoFloat32(frame.data, frame.channels);
    if (stereo.length === 0) return;
    // Resample decoded-rate stereo up to the AudioContext rate when needed.
    const out = this.resampler ? this.resampler.process(stereo) : stereo;
    if (out.length === 0) return;
    // Track frames in OUTPUT-rate samples so pushed/consumed stay comparable.
    this.pushedFrames += out.length / 2;
    node.port.postMessage({ type: "pcm", data: out }, [out.buffer]);
  }

  // #endregion
}

/**
 * Downmix interleaved little-endian PCM16 to interleaved stereo Float32.
 *
 * Channel order follows the AV3A bed layout: 0=L, 1=R, 2=C, 3=LFE, then
 * symmetric (left, right) pairs (surrounds/heights). LFE is skipped for a
 * stereo fold (avoids rumble), centre is spread at 0.707 to both sides, and
 * each pair folds into its own side. Output is clamped so the naive
 * full-scale summing distortion cannot occur.
 */
function pcm16ToStereoFloat32(
  data: ArrayBuffer,
  channels: number
): Float32Array {
  const src = new Int16Array(data);
  const ch = channels > 0 ? Math.min(channels, src.length) : 0;
  if (src.length === 0 || ch <= 0) return new Float32Array(0);

  const frames = Math.floor(src.length / ch);
  const out = new Float32Array(frames * 2);
  const scale = 1 / 32768;

  for (let i = 0; i < frames; i++) {
    const base = i * ch;
    let l = src[base] * scale;
    let r = ch > 1 ? src[base + 1] * scale : l;
    if (ch > 2) {
      const c = src[base + 2] * scale * 0.7071; // centre -> both sides
      l += c;
      r += c;
    }
    // LFE (index 3) intentionally omitted; pairs start at index 4.
    for (let c = 4; c < ch; c++) {
      const v = src[base + c] * scale * 0.5;
      if ((c & 1) === 0) {
        l += v;
      } else {
        r += v;
      }
    }
    out[i * 2] = clampF32(l);
    out[i * 2 + 1] = clampF32(r);
  }
  return out;
}

function clampF32(v: number): number {
  return v > 1 ? 1 : v < -1 ? -1 : v;
}

/**
 * Streaming linear stereo resampler from a fixed source rate to a fixed
 * destination rate. Fractional state is carried across `process` calls so
 * block boundaries stay sample-accurate (no clicks between decode frames).
 */
class StereoResampler {
  private step: number; // source samples per output sample
  private lq: number[] = [];
  private rq: number[] = [];
  private qBase = 0; // absolute source index of lq[0]
  private pos = 0; // absolute source position (float) of the next output

  constructor(srcRate: number, dstRate: number) {
    this.step = srcRate / dstRate;
  }

  /** Change the source samples consumed per output sample (playback rate). */
  setStep(step: number): void {
    if (Number.isFinite(step) && step > 0) {
      this.step = step;
    }
  }

  reset(): void {
    this.lq.length = 0;
    this.rq.length = 0;
    this.qBase = 0;
    this.pos = 0;
  }

  /** Append an interleaved stereo block at srcRate; return the resampled one. */
  process(input: Float32Array): Float32Array {
    const n = input.length >> 1;
    if (n <= 0) return new Float32Array(0);
    for (let i = 0; i < n; i++) {
      this.lq.push(input[i * 2]);
      this.rq.push(input[i * 2 + 1]);
    }
    const end = this.qBase + this.lq.length;
    const out: number[] = [];
    while (Math.floor(this.pos) + 1 < end) {
      const i0 = Math.floor(this.pos) - this.qBase;
      const f = this.pos - Math.floor(this.pos);
      const l = this.lq[i0] + (this.lq[i0 + 1] - this.lq[i0]) * f;
      const r = this.rq[i0] + (this.rq[i0 + 1] - this.rq[i0]) * f;
      out.push(l, r);
      this.pos += this.step;
    }
    // Drop samples never referenced again; always keep >= 1 so the next push
    // can interpolate across the boundary.
    const keep = this.lq.length - 1;
    const drop = Math.max(0, Math.min(Math.floor(this.pos) - this.qBase, keep));
    if (drop > 0) {
      this.lq.splice(0, drop);
      this.rq.splice(0, drop);
      this.qBase += drop;
    }
    return Float32Array.from(out);
  }
}
