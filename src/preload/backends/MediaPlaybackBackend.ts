import type { PlaybackBackend, PlaybackEventSink } from "../PlaybackBackend";

/**
 * The media-element backend. Owns the hidden `<audio>` element and its
 * `MediaElementAudioSourceNode` so its output flows through the shared WebAudio
 * graph. Real element events are raised through the sink (which `Player` gates
 * to the active backend).
 */
export class MediaPlaybackBackend implements PlaybackBackend {
  readonly sourceNode: MediaElementAudioSourceNode;

  private readonly element: HTMLAudioElement;
  private readonly sink: PlaybackEventSink;

  constructor(ctx: AudioContext, sink: PlaybackEventSink) {
    this.sink = sink;

    const element = new Audio();
    element.crossOrigin = "anonymous";
    element.volume = 1;
    this.element = element;
    this.sourceNode = ctx.createMediaElementSource(element);

    const dataless: Array<Parameters<PlaybackEventSink>[0]> = [
      "play",
      "playing",
      "pause",
      "ended",
      "stalled",
      "seeking",
      "seeked",
      "timeupdate",
      "durationchange",
      "ratechange",
    ];
    for (const name of dataless) {
      element.addEventListener(name, () => this.sink(name));
    }
    element.addEventListener("error", (event) => this.sink("error", event));
    // A real "canplay" is the media element's readiness signal.
    element.addEventListener("canplay", () => this.sink("load"));
  }

  load(): Promise<void> {
    this.element.src = `audio://audio?t=${Date.now()}`;
    this.element.load();
    return Promise.resolve();
  }

  async play(): Promise<void> {
    await this.element.play();
  }

  pause(): void {
    this.element.pause();
  }

  stop(): void {
    this.element.pause();
    this.element.currentTime = 0;
    this.element.src = "";
  }

  seek(seconds: number): void {
    this.element.currentTime = seconds;
  }

  get currentTime(): number {
    return this.element.currentTime;
  }

  get duration(): number {
    return this.element.duration;
  }

  get paused(): boolean {
    return this.element.paused;
  }

  get ended(): boolean {
    return this.element.ended;
  }

  get playbackRate(): number {
    return this.element.playbackRate;
  }

  setPlaybackRate(rate: number): void {
    this.element.playbackRate = rate;
  }

  async dispose(): Promise<void> {
    // Drop any leftover source so a stale audio://audio request can't spam.
    this.element.pause();
    this.element.removeAttribute("src");
    this.element.load();
  }
}
