/// <reference types="@types/audioworklet" />

/**
 * Playback worklet for the AV3A decode path.
 *
 * The main process decodes AV3A to PCM16 on a worker thread and forwards each
 * frame over the `av3a` typed bridge. This worklet converts nothing — it
 * receives already-stereo interleaved Float32 blocks through its port, queues
 * them, and renders exactly 128 samples per callback. It reports consumed
 * frames back to the main thread so the player can compute an accurate
 * `currentTime` and apply decode backpressure.
 *
 * Messages:
 *   -> { type: "pcm", data: Float32Array }  interleaved stereo, transferable
 *   -> { type: "pause" }                     stop consuming (render silence)
 *   -> { type: "resume" }
 *   -> { type: "reset" }
 *   <- { type: "consumed", frames: number }
 */

const REPORT_EVERY_FRAMES = 1024;

type PcmBlock = {
  l: Float32Array;
  r: Float32Array;
  pos: number;
};

class Av3aPlayerProcessor extends AudioWorkletProcessor {
  private blocks: PcmBlock[] = [];
  private consumedSinceReport = 0;
  /** While paused, render silence and do NOT consume (playhead stays frozen). */
  private paused = false;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type: string; data?: Float32Array };
      if (!msg) return;
      if (msg.type === "reset") {
        this.blocks = [];
        this.consumedSinceReport = 0;
        return;
      }
      if (msg.type === "pause") {
        this.paused = true;
        return;
      }
      if (msg.type === "resume") {
        this.paused = false;
        return;
      }
      if (msg.type === "pcm" && msg.data) {
        this.push(msg.data);
      }
    };
  }

  private push(interleaved: Float32Array): void {
    const frames = Math.floor(interleaved.length / 2);
    if (frames <= 0) return;
    const l = new Float32Array(frames);
    const r = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      l[i] = interleaved[i * 2];
      r[i] = interleaved[i * 2 + 1];
    }
    this.blocks.push({ l, r, pos: 0 });
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output) return true;

    const left = output[0];
    const right = output[1] ?? output[0];
    const length = left.length;

    // Paused: render silence without consuming or reporting, so the playhead
    // stays frozen while the shared AudioContext keeps running (other graph
    // nodes — effects, honeypot — stay alive).
    if (this.paused) {
      for (let i = 0; i < length; i++) {
        left[i] = 0;
        right[i] = 0;
      }
      return true;
    }

    let produced = 0;
    while (produced < length) {
      const head = this.blocks[0];
      if (!head) break;
      const available = head.l.length - head.pos;
      const take = Math.min(length - produced, available);
      left.set(head.l.subarray(head.pos, head.pos + take), produced);
      right.set(head.r.subarray(head.pos, head.pos + take), produced);
      head.pos += take;
      produced += take;
      if (head.pos >= head.l.length) {
        this.blocks.shift();
      }
    }

    // Underrun: output silence until more PCM arrives.
    for (let i = produced; i < length; i++) {
      left[i] = 0;
      right[i] = 0;
    }

    this.consumedSinceReport += produced;
    if (this.consumedSinceReport >= REPORT_EVERY_FRAMES) {
      this.port.postMessage({
        type: "consumed",
        frames: this.consumedSinceReport,
      });
      this.consumedSinceReport = 0;
    } else if (this.blocks.length === 0 && this.consumedSinceReport > 0) {
      // The queue drained with a partial (< REPORT_EVERY_FRAMES) tail. Flush it
      // now so the player's consumed counter reaches `pushed` exactly when the
      // last sample plays, letting it emit "ended" reliably.
      this.port.postMessage({
        type: "consumed",
        frames: this.consumedSinceReport,
      });
      this.consumedSinceReport = 0;
    }
    return true;
  }
}

registerProcessor("av3a-player", Av3aPlayerProcessor);
