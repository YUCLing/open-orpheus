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
  showTranslate: string;
  showHorizontal: boolean;
  offset: number;
  slogan: string;
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

  songInfo: SongInfo | null = null;
  private _lyricContent: LyricContent | null = null;

  get lyricContent(): LyricContent | null {
    return this._lyricContent;
  }

  set lyricContent(value: LyricContent | null) {
    this._lyricContent = value;
    this.dispatchEvent(
      new CustomEvent("lyriccontentupdate", { detail: value })
    );
  }
  lyricStyle: LyricStyle = this._createStyleProxy({
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
    showTranslate: "",
    showHorizontal: false,
    offset: 0,
    slogan: "",
    desktopTopMost: false,
    locked: false,
  });
  playlist: Playlist = { items: [], currentPlay: "" };

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
