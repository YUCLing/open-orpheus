import Emittery from "emittery";

import { LyricsStore } from "$sharedTypes/lyrics";

export type LyricsDispatcherEvents = {
  lyricsupdate: LyricsStore | null;
  sloganupdate: string | null;
  playstateupdate: boolean;
  timeupdate: number;
  playbackratechange: number;
};

// TODO: Lyric track within main process.
export default class LyricsDispatcher extends Emittery<LyricsDispatcherEvents> {
  private _lyrics: LyricsStore | null = null;
  private _slogan: string | null = null;
  private _playState = false;
  private _time = 0;
  private _playbackRate = 1;

  get lyrics() {
    return this._lyrics;
  }

  set lyrics(value) {
    this._lyrics = value;
    if (value) this.slogan = null;
    this.emit("lyricsupdate", value);
  }

  get slogan() {
    return this._slogan;
  }

  set slogan(value) {
    this._slogan = value;
    if (value) this.lyrics = null;
    this.emit("sloganupdate", value);
  }

  get playState() {
    return this._playState;
  }

  set playState(value) {
    this._playState = value;
    this.emit("playstateupdate", value);
  }

  get time() {
    return this._time;
  }

  set time(value) {
    this._time = value;
    this.emit("timeupdate", value);
  }

  get playbackRate() {
    return this._playbackRate;
  }

  set playbackRate(value) {
    this._playbackRate = value;
    this.emit("playbackratechange", value);
  }
}
