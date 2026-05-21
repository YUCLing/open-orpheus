import type { ShowTranslate } from "$sharedTypes/desktop-lyrics";

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

export type TextAlignType = "left" | "center" | "right";

export type LyricStyle = {
  // Colors
  lrcColorNotPlayedTop: string;
  lrcColorNotPlayedBottom: string;
  lrcColorPlayedTop: string;
  lrcColorPlayedBottom: string;
  outlineColorNotPlayed: string;
  outlineColorPlayed: string;
  outlineShadow: [boolean, boolean, boolean, boolean];
  // Font
  lrcFontSize: string;
  lrcFontBold: boolean;
  lrcFontName: string;
  fontName: string;
  fontSize: number;
  // Display
  textAlign: [TextAlignType, TextAlignType];
  lineMode: boolean;
  showTranslate: ShowTranslate;
  showHorizontal: boolean;
  offset: number;
  // Window
  desktopTopMost: boolean;
  locked: boolean;
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

const DEFAULT_LYRIC_STYLE: LyricStyle = {
  lrcColorNotPlayedTop: "",
  lrcColorNotPlayedBottom: "",
  lrcColorPlayedTop: "",
  lrcColorPlayedBottom: "",
  outlineColorNotPlayed: "",
  outlineColorPlayed: "",
  outlineShadow: [false, false, false, false],
  lrcFontSize: "",
  lrcFontBold: false,
  lrcFontName: "",
  fontName: "",
  fontSize: 36,
  textAlign: ["center", "center"],
  lineMode: false,
  showTranslate: "translate",
  showHorizontal: false,
  offset: 0,
  desktopTopMost: false,
  locked: false,
};

export default class Player extends EventTarget {
  private _audioCtx: AudioContext = new AudioContext();
  private _audio = new Audio();

  private _audioSourceNode = this._audioCtx.createMediaElementSource(
    this._audio
  );

  private _gainNode = this._audioCtx.createGain();

  private _pcmTapNode: AudioWorkletNode | null = null;
  private _pcmTapReady = false;
  private _audioDataEnabled = false;

  private _playInfo: AudioPlayInfo | null = null;
  private _lyricContent: LyricContent | null = null;

  songInfo: SongInfo | null = null;
  lyricStyle: LyricStyle = this._createStyleProxy(DEFAULT_LYRIC_STYLE);
  playlist: Playlist = { items: [], currentPlay: "" };

  // #region Getters & Setters
  get enableAudioData() {
    return this._audioDataEnabled;
  }

  set enableAudioData(value: boolean) {
    if (this._audioDataEnabled === value) return;
    this._audioDataEnabled = value;
    if (value) {
      this._connectPcmTap();
    } else {
      this._disconnectPcmTap();
    }
  }

  get lyricContent(): LyricContent | null {
    return this._lyricContent;
  }

  set lyricContent(value: LyricContent | null) {
    this._lyricContent = value;
    this.dispatchEvent(
      new CustomEvent("lyriccontentupdate", { detail: value })
    );
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
    this.dispatchEvent(new CustomEvent("volumechange", { detail: value }));
  }
  // #endregion

  constructor() {
    super();

    this._audio.crossOrigin = "anonymous";
    this._audio.volume = 1;

    this._audioSourceNode.connect(this._gainNode);
    this._gainNode.connect(this._audioCtx.destination);
  }

  private async _ensurePcmTapReady() {
    if (this._pcmTapReady) return;
    this._pcmTapReady = true;

    await this._audioCtx.audioWorklet.addModule(
      "audio://worklet/audio-data.js"
    );

    this._pcmTapNode = new AudioWorkletNode(this._audioCtx, "pcm-tap", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: "explicit",
    });

    this._pcmTapNode.port.onmessage = (ev) => {
      this.dispatchEvent(new CustomEvent("audiodata", { detail: ev.data }));
    };
  }

  private async _connectPcmTap() {
    await this._ensurePcmTapReady();
    if (!this._pcmTapNode) return;

    // Rewire: source → tap → destination
    this._audioSourceNode.disconnect();
    this._audioSourceNode.connect(this._pcmTapNode);
    this._pcmTapNode.connect(this._gainNode);
  }

  private _disconnectPcmTap() {
    if (!this._pcmTapNode) return;

    // Rewire: source → destination (bypass tap)
    this._pcmTapNode.disconnect();
    this._audioSourceNode.disconnect();
    this._audioSourceNode.connect(this._gainNode);
    this._pcmTapNode.port.postMessage("reset");
  }

  private _createStyleProxy(style: LyricStyle): LyricStyle {
    return new Proxy(style, {
      set: (target, prop, value) => {
        const oldValue = target[prop as keyof LyricStyle];
        (target as Record<string | symbol, unknown>)[prop] = value;
        if (oldValue !== value) {
          this.dispatchEvent(
            new CustomEvent("lyricstyleupdate", {
              detail: { key: prop, value },
            })
          );
        }
        return true;
      },
    });
  }

  async load(playInfo: AudioPlayInfo): Promise<HTMLAudioElement> {
    this._playInfo = playInfo;
    this.dispatchEvent(new CustomEvent("playinfoupdate"));
    this._audio.addEventListener(
      "canplay",
      () => {
        this.dispatchEvent(
          new CustomEvent("load", { detail: { id: this.currentId } })
        );
      },
      { once: true }
    );
    this._audio.src = `audio://audio/${playInfo.songId}`;
    this._audio.load();
    return this._audio;
  }

  stop() {
    this._audio.pause();
    this._audio.currentTime = 0;
    this._audio.src = "";
    this._playInfo = null;
    this._pcmTapNode?.port.postMessage("reset");
  }
}
