import Emittery from "emittery";

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

export default class Player extends Emittery<PlayerEvents> {
  private _audioCtx: AudioContext = new AudioContext();
  private _audio = new Audio();

  private _audioSourceNode = this._audioCtx.createMediaElementSource(
    this._audio
  );

  private _gainNode = this._audioCtx.createGain();

  private _honeyPotPromise: Promise<AudioWorkletNode>;
  private _audioDataEnabled = false;

  private _playInfo: AudioPlayInfo | null = null;
  private _lyricContent: LyricContent | null = null;

  songInfo: SongInfo | null = null;
  playlist: Playlist = { items: [], currentPlay: "" };

  // #region Getters & Setters
  get enableAudioData() {
    return this._audioDataEnabled;
  }

  set enableAudioData(value: boolean) {
    if (this._audioDataEnabled === value) return;
    this._audioDataEnabled = value;
    (async () => {
      const pcmHoneypot = await this._honeyPotPromise;
      if (value) {
        this._audioSourceNode.connect(pcmHoneypot);
      } else {
        this._audioSourceNode.disconnect(pcmHoneypot);
      }
    })();
  }

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
    return this._gainNode;
  }

  get currentId() {
    return this._playInfo?.playId ?? "";
  }

  get currentPlayInfo() {
    return this._playInfo;
  }

  get volume() {
    return this._gainNode.gain.value;
  }
  set volume(value: number) {
    this._gainNode.gain.value = value;
    this.emit("volumechange", value);
  }
  // #endregion

  constructor() {
    super();

    this._audio.crossOrigin = "anonymous";
    this._audio.volume = 1;

    this._audioSourceNode.connect(this._gainNode);
    this._gainNode.connect(this._audioCtx.destination);

    this._honeyPotPromise = this._audioCtx.audioWorklet
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

        return node;
      });
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

  async stop() {
    this._audio.pause();
    this._audio.currentTime = 0;
    this._audio.src = "";
    this._playInfo = null;
    (await this._honeyPotPromise).port.postMessage("reset");
  }
}
