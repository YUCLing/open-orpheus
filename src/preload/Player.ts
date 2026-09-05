import Emittery from "emittery";

import AudioEffectManager from "./AudioEffectManager";
import { Av3aPlaybackBackend } from "./backends/Av3aPlaybackBackend";
import { MediaPlaybackBackend } from "./backends/MediaPlaybackBackend";
import { dbToGain } from "../util";
import type { PlaybackBackend, PlaybackEventName } from "./PlaybackBackend";

export enum AudioPlayerState {
  Null = 0,
  Playing = 1,
  Paused = 2,
  Error = 3,
}

export type SongInfo = {
  playId: string;
  songName: string;
  artistName: string;
  albumId: string;
  albumName: string;
  songType: string;
  artworkUrl: string;
  cover: string;
  totalTime: number;
  liked: boolean;
};

export type LyricContent = {
  krc: string;
  lrc: string;
  romalrc: string;
  tlrc: string;
  yrc: string;
};

export type PlaylistItem = {
  id: string;
  from: string;
  title: string;
  track_id: string;
  program: unknown | null;
  mv: string;
  album: string;
  artist: string;
  alias: string;
  cloud: number;
};

export type Playlist = {
  items: PlaylistItem[];
  currentPlay: string;
};

export type AudioPlayInfo = {
  playId: string;
  aiprocessorRatio: number;
  destLevel: string;
  songId: string;
  songQuality:
    | "standard"
    | "exhigh"
    | "hires"
    | "jyeffect"
    | "vivid"
    | "sky"
    | "jymaster"
    | string;
} & (
  | {
      type: 0;
      bitrate: "exhigh" | "hires" | string;
      path: string;
      playbrt: number;
    }
  | {
      type: 4;
      songId: string;
      audioFormat: "m4a" | "flac" | "av3a" | string;
      audioType: "track" | string;
      bitrate: number;
      br: string;
      expireTime: number;
      extHeader: string;
      fileSize: number;
      format: unknown;
      freeTrialInfo: unknown | null;
      freeTrialPrivilege: {
        resConsumable: boolean;
        userConsumable: boolean;
        listenType: unknown | null;
        playReason: unknown | null;
        cannotListenReason: unknown | null;
        freeLimitTagType: unknown | null;
      };
      level: string;
      md5: string;
      playInfoStr: string;
      podcastCtrp: unknown | null;
      rightSource: number;
      songDuration: string;
      musicurl: string;
    }
);

export type PlayerEvents = {
  lyriccontentupdate: LyricContent | null;
  volumechange: number;
  audiodata: { data: ArrayBuffer; pts: number };
  lyricstyleupdate: { key: string | symbol; value: unknown };
  playinfoupdate: AudioPlayInfo;
  load: { id: string };
  // Media-surface events. Emitted by the active playback backend (media
  // element or AV3A) and re-emitted here with these types.
  play: undefined;
  playing: undefined;
  pause: undefined;
  ended: undefined;
  /** Decode error (Error, AV3A) or a media-element error event. */
  error: Error | Event;
  stalled: undefined;
  seeking: undefined;
  seeked: undefined;
  timeupdate: undefined;
  durationchange: undefined;
  ratechange: undefined;
};

export function isAv3aPlayInfo(playInfo: AudioPlayInfo | null): boolean {
  return playInfo?.type === 4 && playInfo.audioFormat === "av3a";
}

/**
 * Convert volume (0-1) to linear gain, logarithmic mapping.
 *
 * @param input
 * @returns
 */
function volumeToGain(input: number, minDb = 40) {
  if (input === 0) return 0;

  // Convert volume to dB (negative = attenuation)
  const db = -minDb * (1 - input);

  return dbToGain(db);
}

export default class Player extends Emittery<PlayerEvents> {
  private _audioCtx: AudioContext = new AudioContext();
  private _audioEffectManager = new AudioEffectManager(this._audioCtx);
  private _honeyPotPromise: Promise<AudioWorkletNode>;

  // Backends (each owns its engine); `_backend` is whichever is active.
  private _media: MediaPlaybackBackend;
  private _av3a: Av3aPlaybackBackend;
  private _backend: PlaybackBackend;

  private _playInfo: AudioPlayInfo | null = null;
  private _lyricContent: LyricContent | null = null;
  private _volume = 1;

  songInfo: SongInfo | null = null;
  playlist: Playlist = { items: [], currentPlay: "" };

  // #region Getters & Setters
  get lyricContent(): LyricContent | null {
    return this._lyricContent;
  }

  set lyricContent(value: LyricContent | null) {
    this._lyricContent = value;
    void this.emit("lyriccontentupdate", value);
  }

  get audioContext() {
    return this._audioCtx;
  }

  get currentTime(): number {
    return this._backend.currentTime;
  }
  set currentTime(value: number) {
    this._backend.seek(value);
  }

  get duration(): number {
    return this._backend.duration;
  }

  get paused(): boolean {
    return this._backend.paused;
  }

  get ended(): boolean {
    return this._backend.ended;
  }

  get playbackRate(): number {
    return this._backend.playbackRate;
  }
  set playbackRate(value: number) {
    this._backend.setPlaybackRate(value);
  }

  get isAv3aActive(): boolean {
    return this._backend === this._av3a;
  }

  get gainNode() {
    return this._audioEffectManager.output;
  }

  get currentId() {
    return this._playInfo?.playId ?? "";
  }

  get currentPlayInfo() {
    return this._playInfo;
  }

  get volume() {
    return this._volume;
  }
  set volume(value: number) {
    this._volume = value;
    // TODO: Maybe allow user to custom minimal dB value in the future
    this.gainNode.gain.value = volumeToGain(value);
    void this.emit("volumechange", value);
  }

  get replayGain() {
    return this._audioEffectManager.input;
  }

  /**
   * The audio effect manager of the player.
   *
   * Note that its input is currently being used as replay gain, and
   * its output is currently being used as volume gain.
   */
  get audioEffectManager() {
    return this._audioEffectManager;
  }
  // #endregion

  constructor() {
    super();

    this._media = new MediaPlaybackBackend(this._audioCtx, (name, data) =>
      this.onBackendEvent(this._media, name, data)
    );
    this._av3a = new Av3aPlaybackBackend(
      this._audioCtx,
      this._audioEffectManager.input,
      (name, data) => this.onBackendEvent(this._av3a, name, data)
    );
    this._backend = this._media;

    // Both backends feed the shared effect chain; the chain feeds the speakers.
    this._media.sourceNode.connect(this._audioEffectManager.input);
    this._audioEffectManager.output.connect(this._audioCtx.destination);

    // If the context stops on its own, only the media element needs pausing
    // (the AV3A backend already suspends the context as its pause).
    this._audioCtx.addEventListener("statechange", () => {
      if (this._audioCtx.state !== "running" && this._backend === this._media) {
        this._media.pause();
      }
    });

    // Ensure gain stays consistent with volume.
    this.volume = this._volume;

    this._honeyPotPromise = new Promise((resolve, reject) => {
      let attempts = 0;
      const loadHoneypot = () => {
        attempts++;
        this._audioCtx.audioWorklet
          .addModule("audio://worklet/pcm-honeypot.js")
          .then(() => {
            const node = new AudioWorkletNode(this._audioCtx, "pcm-honeypot", {
              numberOfInputs: 1,
              numberOfOutputs: 0,
              channelCount: 2,
              channelCountMode: "explicit",
            });

            node.port.onmessage = (ev) => {
              void this.emit("audiodata", ev.data);
            };

            resolve(node);
          })
          .catch((e) => {
            // Failed, debounce retry 30 times (max 30s, add 1s per attempt)
            if (attempts > 30) {
              reject(e);
              return;
            }
            setTimeout(loadHoneypot, attempts * 1000);
          });
      };

      // Start the initial attempt
      loadHoneypot();
    });
  }

  private async ensureAudioContextState(running = true) {
    if (running && this._audioCtx.state !== "running") {
      await this._audioCtx.resume();
    } else if (!running && this._audioCtx.state === "running") {
      await this._audioCtx.suspend();
    }
  }

  async load(playInfo: AudioPlayInfo): Promise<void> {
    const isAv3a = isAv3aPlayInfo(playInfo);
    const next: PlaybackBackend = isAv3a ? this._av3a : this._media;

    // Switching engines: retire the old one first (stops the decode session or
    // clears a stale media-element source), then delegate to the new one.
    if (next !== this._backend) {
      const previous = this._backend;
      this._backend = next;
      await previous.dispose();
    }

    this._playInfo = playInfo;
    await this.emit("playinfoupdate", playInfo);
    await next.load(playInfo);
  }

  async play() {
    await this.ensureAudioContextState();
    await this._backend.play();
  }

  pause() {
    this._backend.pause();
  }

  stop() {
    this._playInfo = null;
    this._backend.stop();
    // Simply try, does nothing if failed.
    this._honeyPotPromise
      .then((node) => {
        node.port.postMessage("reset");
      })
      .catch(() => {});
  }

  async setAudioDataEnabled(enabled: boolean) {
    const node = await this._honeyPotPromise;
    const source = this._backend.sourceNode;
    if (!source) return;
    if (enabled) {
      source.connect(node);
    } else {
      node.port.postMessage("reset");
      try {
        source.disconnect(node);
      } catch (err) {
        if (err instanceof DOMException && err.name === "InvalidAccessError")
          return;
        throw err;
      }
    }
  }

  /**
   * Route a media event from `source` into the typed Player event stream, but
   * only when `source` is the currently active backend (so a retired backend's
   * late events never leak through).
   */
  private onBackendEvent(
    source: PlaybackBackend,
    name: PlaybackEventName,
    data?: unknown
  ): void {
    if (source !== this._backend) return;
    switch (name) {
      case "load":
        void this.emit("load", { id: this.currentId });
        break;
      case "error":
        void this.emit("error", data as Error | Event);
        break;
      default: {
        // The remaining events carry no payload.
        const emit = this.emit as (
          eventName: PlaybackEventName
        ) => Promise<void>;
        void emit(name);
        break;
      }
    }
  }
}
