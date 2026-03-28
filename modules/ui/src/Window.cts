import {
  focusWindow,
  showWindow,
  hideWindow,
  setAlwaysOnTop,
  setWindowBounds,
  dragWindow,
} from "./module.cjs";

/**
 * Base class wrapping native window operations.
 * Does not manage window lifecycle (creation/destruction).
 * @internal — only used within this library.
 */
export default class Window {
  private readonly _appPtr: number;
  private readonly _windowId: number;

  /** @internal */
  constructor(appPtr: number, windowId: number) {
    this._appPtr = appPtr;
    this._windowId = windowId;
  }

  focus(): void {
    focusWindow(this._appPtr, this._windowId);
  }

  show(): void {
    showWindow(this._appPtr, this._windowId);
  }

  hide(): void {
    hideWindow(this._appPtr, this._windowId);
  }

  setAlwaysOnTop(onTop: boolean): void {
    setAlwaysOnTop(this._appPtr, this._windowId, onTop);
  }

  setBounds(x: number, y: number, width: number, height: number): void {
    setWindowBounds(this._appPtr, this._windowId, x, y, width, height);
  }

  dragWindow(): void {
    dragWindow(this._appPtr, this._windowId);
  }
}
