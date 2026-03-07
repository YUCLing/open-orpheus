export enum AudioPlayerState {
  Null = 0,
  Playing = 1,
  Paused = 2,
  Error = 3,
}

export type AudioPlayInfo = {
  playId: string;
  songId: string;
  aiprocessorRatio: number;
  audioFormat: string;
  audioType: string;
  birate: number;
  br: string;
  destLevel: string;
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
  songQuality: string;
  type: number;
};

export default class Player extends EventTarget {
  private _audio: HTMLAudioElement = new Audio();
  private _playInfo: AudioPlayInfo | null = null;

  get audio() {
    return this._audio;
  }

  get currentId() {
    return this._playInfo?.playId ?? "";
  }

  get currentPlayInfo() {
    return this._playInfo;
  }

  constructor() {
    super();
    this._audio.addEventListener("canplay", () => {
      this.dispatchEvent(
        new CustomEvent("load", { detail: { id: this.currentId } })
      );
    });
  }

  getAudioElement(): HTMLAudioElement | undefined {
    return this._audio;
  }

  async load(playInfo: AudioPlayInfo): Promise<HTMLAudioElement> {
    this._playInfo = playInfo;
    this._audio.src = playInfo.musicurl;
    this._audio.load();
    return this._audio;
  }

  stop() {
    this._audio.pause();
    this._audio.currentTime = 0;
    this._audio.src = "";
    this._playInfo = null;
  }
}
