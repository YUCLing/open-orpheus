import App from "./App.cjs";
import {
  createOsrWindow,
  destroyOsrWindow,
  osrWindowClose,
  osrWindowDrag,
  osrWindowResize,
  osrWindowSetCursor,
  osrWindowSetInputHandler,
  osrWindowUpdateFrame,
} from "./module.cjs";

export interface OsrWindowOptions {
  width: number;
  height: number;
  transparent?: boolean;
  resizable?: boolean;
  alwaysOnTop?: boolean;
  skipTaskbar?: boolean;
  title?: string;
}

export interface OsrInputEvent {
  type:
    | "mouseMove"
    | "mouseDown"
    | "mouseUp"
    | "mouseWheel"
    | "mouseEnter"
    | "mouseLeave"
    | "resize"
    | "focus"
    | "blur"
    | "close";
  x?: number;
  y?: number;
  button?: string;
  click_count?: number;
  delta_x?: number;
  delta_y?: number;
  width?: number;
  height?: number;
  scale_factor?: number;
}

const finalizer = new FinalizationRegistry((ptr: number) => {
  destroyOsrWindow(ptr);
});

export default class OsrWindow {
  private _ptr: number;

  private constructor(ptr: number) {
    this._ptr = ptr;
  }

  /**
   * Create a native window for displaying offscreen-rendered content.
   */
  static async create(app: App, options: OsrWindowOptions): Promise<OsrWindow> {
    const ptr = await createOsrWindow(
      (app as unknown as { _ptr: number })._ptr,
      options
    );
    const win = new OsrWindow(ptr);
    finalizer.register(win, ptr);
    return win;
  }

  /**
   * Send a BGRA bitmap frame to the native window.
   * Use `NativeImage.getBitmap()` to obtain the buffer.
   */
  updateFrame(buffer: Buffer, width: number, height: number): void {
    osrWindowUpdateFrame(this._ptr, buffer, width, height);
  }

  /**
   * Register a handler for input and lifecycle events from the native window.
   * The callback receives a JSON-serialised `OsrInputEvent`.
   */
  onInput(callback: (event: OsrInputEvent) => void): void {
    osrWindowSetInputHandler(this._ptr, (json: string) => {
      callback(JSON.parse(json));
    });
  }

  /**
   * Resize the native window to the given logical dimensions.
   */
  resize(width: number, height: number): void {
    osrWindowResize(this._ptr, width, height);
  }

  /**
   * Set the cursor icon on the native window from a CSS cursor name.
   */
  setCursor(cursorName: string): void {
    osrWindowSetCursor(this._ptr, cursorName);
  }

  /**
   * Begin an interactive drag of the native window.
   *
   * Call this from a `mouseDown` handler when the pointer is inside a
   * drag region (e.g. a title bar rendered by the web content).
   */
  drag(): void {
    osrWindowDrag(this._ptr);
  }

  /**
   * Close the native window (it can no longer be used after this).
   */
  close(): void {
    osrWindowClose(this._ptr);
  }
}
