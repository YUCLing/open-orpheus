import App from "./App.cjs";
import Window from "./Window.cjs";
import {
  createLyricsWindow,
  destroyLyricsWindow,
  setLyricsData,
  setLyricsTime,
  setLyricsStyle,
} from "./module.cjs";

type LyricsData = Parameters<typeof setLyricsData>[1];
export type LyricsStyleDto = Parameters<typeof setLyricsStyle>[1];

const finalizer = new FinalizationRegistry((ptr: number) => {
  destroyLyricsWindow(ptr);
});

export default class LyricsWindow extends Window {
  private _ptr: number;

  private constructor(appPtr: number, windowId: number, ptr: number) {
    super(appPtr, windowId);
    this._ptr = ptr;
    finalizer.register(this, this._ptr);
  }

  static async create(
    app: App,
    options?: { show?: boolean }
  ): Promise<LyricsWindow> {
    const appPtr = (app as unknown as { _ptr: number })._ptr;
    const [ptr, windowId] = await createLyricsWindow(
      appPtr,
      options?.show ?? true
    );
    return new LyricsWindow(appPtr, windowId, ptr);
  }

  setData(data: LyricsData): void {
    setLyricsData(this._ptr, data);
  }

  setTime(timeMs: number): void {
    setLyricsTime(this._ptr, timeMs);
  }

  setStyle(style: LyricsStyleDto): void {
    setLyricsStyle(this._ptr, style);
  }

  destroy(): void {
    destroyLyricsWindow(this._ptr);
  }
}
