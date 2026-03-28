import App from "./App.cjs";
import {
  createLyricsWindow,
  destroyLyricsWindow,
  setLyricsData,
  setLyricsTime,
} from "./module.cjs";

type LyricsData = Parameters<typeof setLyricsData>[1];

const finalizer = new FinalizationRegistry((ptr: number) => {
  destroyLyricsWindow(ptr);
});

export default class LyricsWindow {
  private _ptr: number;

  private constructor(ptr: number) {
    this._ptr = ptr;
    finalizer.register(this, this._ptr);
  }

  static async create(app: App): Promise<LyricsWindow> {
    const ptr = await createLyricsWindow(
      (app as unknown as { _ptr: number })._ptr
    );
    return new LyricsWindow(ptr);
  }

  setData(data: LyricsData): void {
    setLyricsData(this._ptr, data);
  }

  setTime(timeMs: number): void {
    setLyricsTime(this._ptr, timeMs);
  }

  destroy(): void {
    destroyLyricsWindow(this._ptr);
  }
}
