import type { AudioPlayInfo } from "../Player";
import type { PlaybackBackend, PlaybackEventSink } from "../PlaybackBackend";
import { Av3aPcmPlayer } from "../av3a/Av3aPcmPlayer";

/**
 * The AV3A decode backend. Owns an `Av3aPcmPlayer` (worklet playback, PCM
 * resampling/downmix, seek/rate) plus the AV3A timeupdate clock, and raises
 * the same media events as the media-element backend through the sink.
 */
export class Av3aPlaybackBackend implements PlaybackBackend {
  private readonly player: Av3aPcmPlayer;
  private readonly sink: PlaybackEventSink;
  private readonly effectInput: AudioNode;
  private attached = false;
  private clock: number | null = null;
  private openResolve: (() => void) | null = null;
  private playbackRateValue = 1;

  constructor(
    ctx: AudioContext,
    effectInput: AudioNode,
    sink: PlaybackEventSink
  ) {
    this.effectInput = effectInput;
    this.sink = sink;
    this.player = new Av3aPcmPlayer(ctx, {
      onOpened: () => {
        this.sink("durationchange");
        this.sink("timeupdate");
        this.sink("load");
        this.openResolve?.();
        this.openResolve = null;
      },
      onEnded: () => {
        this.stopClock();
        this.sink("ended");
        this.sink("pause");
      },
      onError: (message) => this.sink("error", new Error(message)),
      onBuffering: (buffering) => this.sink(buffering ? "stalled" : "playing"),
    });
  }

  get sourceNode(): AudioNode | null {
    return this.player.sourceNode;
  }

  get currentTime(): number {
    return this.player.currentTime;
  }

  get duration(): number {
    return this.player.duration;
  }

  get paused(): boolean {
    return !this.player.isPlaying;
  }

  get ended(): boolean {
    return false;
  }

  get playbackRate(): number {
    return this.playbackRateValue;
  }

  setPlaybackRate(rate: number): void {
    this.playbackRateValue = rate;
    this.player.setPlaybackRate(rate);
    this.sink("ratechange");
  }

  async load(playInfo: AudioPlayInfo): Promise<void> {
    if (!this.attached) {
      await this.player.attach(this.effectInput);
      this.attached = true;
    }
    const opened = new Promise<void>((resolve) => {
      this.openResolve = resolve;
    });
    try {
      await this.player.start(playInfo);
      await Promise.race([
        opened,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("AV3A open timed out")), 15_000);
        }),
      ]);
    } catch {
      this.openResolve = null;
      // Failures surface through onError -> sink("error").
    }
  }

  async play(): Promise<void> {
    await this.player.play();
    this.startClock();
    this.sink("play");
    this.sink("playing");
  }

  pause(): void {
    this.player.pause();
    this.stopClock();
    this.sink("pause");
  }

  stop(): void {
    this.stopClock();
    void this.player.stop();
    this.sink("pause");
  }

  seek(seconds: number): void {
    this.sink("seeking");
    void this.player.seekTo(seconds).then(() => {
      this.sink("seeked");
    });
  }

  private startClock(): void {
    this.stopClock();
    this.clock = window.setInterval(() => this.sink("timeupdate"), 250);
  }

  private stopClock(): void {
    if (this.clock !== null) {
      window.clearInterval(this.clock);
      this.clock = null;
    }
  }

  async dispose(): Promise<void> {
    this.stopClock();
    await this.player.stop().catch(() => {});
  }
}
