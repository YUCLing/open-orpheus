import Emittery from "emittery";

import AudioEffectManager from "./AudioEffectManager";
import { dbToGain } from "../util";

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
  songQuality: "exhigh" | string;
} & (
  | {
      type: 0;
      bitrage: "exhigh" | string;
      path: string;
      playbrt: number;
    }
  | {
      type: 4;
      songId: string;
      audioFormat: string;
      audioType: string;
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
};

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
  private _audio = new Audio();

  private _audioEffectManager = new AudioEffectManager(this._audioCtx);

  private _audioSourceNode = this._audioCtx.createMediaElementSource(
    this._audio
  );

  private _honeyPotPromise: Promise<AudioWorkletNode>;

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
    this.emit("lyriccontentupdate", value);
  }

  get audioContext() {
    return this._audioCtx;
  }

  get audio() {
    return this._audio;
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
    this.emit("volumechange", value);
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

    this._audioCtx.addEventListener("statechange", () => {
      if (this._audioCtx.state !== "running") {
        // Audio context somehow stopped, ensure we handle this cleanly by
        // firing pause event of audio
        this._audio.pause();
      }
    });

    this._audio.crossOrigin = "anonymous";
    this._audio.volume = 1;

    // Ensure they are consistent
    this.volume = this._volume;

    this._audioSourceNode.connect(this._audioEffectManager.input);
    this._audioEffectManager.output.connect(this._audioCtx.destination);

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
              this.emit("audiodata", ev.data);
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

  async load(playInfo: AudioPlayInfo): Promise<HTMLAudioElement> {
    this._playInfo = playInfo;
    await this.emit("playinfoupdate", playInfo);
    this._audio.addEventListener(
      "canplay",
      () => {
        this.emit("load", { id: this.currentId });
      },
      { once: true }
    );
    this._audio.src = `audio://audio?t=${Date.now()}`;
    this._audio.load();
    return this._audio;
  }

  async setAudioDataEnabled(enabled: boolean) {
    const node = await this._honeyPotPromise;
    if (enabled) {
      this._audioSourceNode.connect(node);
    } else {
      node.port.postMessage("reset");
      try {
        this._audioSourceNode.disconnect(node);
      } catch (err) {
        if (err instanceof DOMException && err.name === "InvalidAccessError")
          return;
        throw err;
      }
    }
  }

  async play() {
    await this.ensureAudioContextState();
    return await this._audio.play();
  }

  pause() {
    this._audio.pause();
  }

  stop() {
    this._audio.pause();
    this._audio.currentTime = 0;
    this._audio.src = "";
    this._playInfo = null;
    // Simply try, does nothing if failed.
    this._honeyPotPromise
      .then((node) => {
        node.port.postMessage("reset");
      })
      .catch(() => {});
  }
}
