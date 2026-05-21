import { LyricsStore } from "$sharedTypes/lyrics";

// TODO: Lyric track within main process.
export default class LyricsDispatcher extends EventTarget {
  private _lyrics: LyricsStore | null = null;
  private _slogan: string | null = null;
  private _playState = false;
  private _time = 0;

  get lyrics() {
    return this._lyrics;
  }

  set lyrics(value) {
    this._lyrics = value;
    if (value) this._slogan = null;
    this.dispatchEvent(
      new CustomEvent("lyricsupdate", {
        detail: value,
      })
    );
  }

  get slogan() {
    return this._slogan;
  }

  set slogan(value) {
    this._slogan = value;
    if (value) this._lyrics = null;
    this.dispatchEvent(
      new CustomEvent("sloganupdate", {
        detail: value,
      })
    );
  }

  get playState() {
    return this._playState;
  }

  set playState(value) {
    this._playState = value;
    this.dispatchEvent(
      new CustomEvent("playstateupdate", {
        detail: value,
      })
    );
  }

  get time() {
    return this._time;
  }

  set time(value) {
    this._time = value;
    this.dispatchEvent(
      new CustomEvent("timeupdate", {
        detail: value,
      })
    );
  }
}
