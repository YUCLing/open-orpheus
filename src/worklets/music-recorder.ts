/// <reference types="@types/audioworklet" />

class MusicRecorderProcessor extends AudioWorkletProcessor {
  private readonly sampleRate: number;
  private readonly totalFrames: number;
  private readonly intervalFrames: number;
  private readonly buffer: Float32Array;

  private writeOffset = 0;
  private nextMatchFrame: number;
  private times = 0;
  private done = false;

  constructor(options?: {
    processorOptions?: {
      sampleRate?: number;
      duration?: number;
      interval?: number;
    };
  }) {
    super();

    const cfg = options?.processorOptions ?? {};
    this.sampleRate = cfg.sampleRate ?? sampleRate;
    const duration = cfg.duration ?? 15;
    const interval = cfg.interval ?? 3;
    this.totalFrames = Math.max(1, Math.round(duration * this.sampleRate));
    this.intervalFrames = Math.max(1, Math.round(interval * this.sampleRate));
    this.buffer = new Float32Array(this.totalFrames);
    this.nextMatchFrame = Math.min(this.intervalFrames, this.totalFrames);
  }

  private postMatch(frameCount: number, final: boolean) {
    if (final) this.done = true;
    this.times++;
    const audioData = this.buffer.slice(0, frameCount).buffer;
    this.port.postMessage(
      {
        type: "match-window",
        audioData,
        duration: frameCount / this.sampleRate,
        final,
        frames: frameCount,
        interval: this.intervalFrames / this.sampleRate,
        sampleRate: this.sampleRate,
        times: this.times,
      },
      [audioData]
    );
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.done) return false;

    const channel = inputs[0]?.[0];
    if (!channel) return true;

    const remaining = this.totalFrames - this.writeOffset;
    const framesToCopy = Math.min(channel.length, remaining);
    if (framesToCopy > 0) {
      this.buffer.set(channel.subarray(0, framesToCopy), this.writeOffset);
      this.writeOffset += framesToCopy;
    }

    // Fire match windows for completed intervals
    while (this.nextMatchFrame <= this.writeOffset) {
      const final = this.nextMatchFrame >= this.totalFrames;
      this.postMatch(this.nextMatchFrame, final);
      if (final) return false;
      this.nextMatchFrame = Math.min(
        this.nextMatchFrame + this.intervalFrames,
        this.totalFrames
      );
    }

    return true;
  }
}

registerProcessor("music-recorder", MusicRecorderProcessor);
