export enum AudioPlayerState {
  Null = 0,
  Playing = 1,
  Paused = 2,
  Error = 3,
}

export default class Player extends EventTarget {
  private _audio: HTMLAudioElement = new Audio();
  private _currentId: string | null = null;

  get audio() {
    return this._audio;
  }

  get currentId() {
    return this._currentId;
  }

  constructor() {
    super();
    this._audio.addEventListener("canplay", () => {
      this.dispatchEvent(
        new CustomEvent("load", { detail: { id: this._currentId } })
      );
    });
    this._audio.addEventListener("play", () => {
      this.dispatchEvent(
        new CustomEvent("play", { detail: { id: this._currentId } })
      );
    });
    this._audio.addEventListener("pause", () => {
      this.dispatchEvent(
        new CustomEvent("pause", { detail: { id: this._currentId } })
      );
    });
    this._audio.addEventListener("ended", () => {
      this.dispatchEvent(
        new CustomEvent("ended", { detail: { id: this._currentId } })
      );
    });
  }

  getAudioElement(): HTMLAudioElement | undefined {
    return this._audio;
  }

  async load(id: string, url: string): Promise<HTMLAudioElement> {
    this._currentId = id;
    this._audio.src = url;
    this._audio.load();
    console.log(`Started loading audio for id: ${id} from url: ${url}`);
    return this._audio;
  }
}
