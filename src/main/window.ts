import os from "node:os";

import { app, BrowserWindow, shell } from "electron";
import Emittery from "emittery";

import {
  getDesktopEnvironment,
  setInputRegion,
  DesktopEnvironment,
} from "@open-orpheus/window";

import AppMenu from "./menu";

const browserManagedWindowMap = new WeakMap<BrowserWindow, ManagedWindow>();
const managedBrowserWindows = new Set<BrowserWindow>();
const managedWindows = new Set<WeakRef<ManagedWindow>>();
const finalizationRegistry = new FinalizationRegistry<WeakRef<ManagedWindow>>(
  (held) => {
    managedWindows.delete(held);
  }
);

export let mainWindow: BrowserWindow | null = null;

export function setMainWindow(wnd: BrowserWindow) {
  mainWindow = wnd;
}

export interface InputRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowEvents {
  /** Window is created or is being bound with current ManagedWindow */
  bind: BrowserWindow;
  /** Window is closed or is being unbound with current ManagedWindow */
  unbind: BrowserWindow;
  show: BrowserWindow;
  hide: BrowserWindow;
}

export type WindowData = {
  name: string;
  maximumSize: { x: number; y: number };
  minimumSize: { x: number; y: number };
  alwaysOnTop: boolean;
  menu: AppMenu;
};

function shouldRespectSizeConstraints(wnd: BrowserWindow) {
  return !wnd.isMaximized() && !wnd.isFullScreen();
}

app.on("browser-window-created", (event, wnd) => {
  setImmediate(() => {
    if (managedBrowserWindows.has(wnd)) return;
    new SimpleManagedWindow(wnd);
  });
});

export abstract class ManagedWindow<
  Data extends WindowData = WindowData,
> extends Emittery<WindowEvents> {
  private _window: BrowserWindow | null = null;
  private _data: Record<string, unknown> = Object.create(null);

  private _lastOnClosedListener: (() => boolean) | null = null;

  protected set window(value) {
    if (this._window === value) return;
    if (this._window) {
      managedBrowserWindows.delete(this._window);
      browserManagedWindowMap.delete(this._window);
      if (this._lastOnClosedListener)
        this._window.off("closed", this._lastOnClosedListener);
      this.emit("unbind", this._window);
    }
    if (value) {
      this._lastOnClosedListener = () => managedBrowserWindows.delete(value);
      value.on("closed", this._lastOnClosedListener);
      managedBrowserWindows.add(value);
      browserManagedWindowMap.set(value, this);
      this.emit("bind", value);
    }
    this._window = value;
  }

  get window() {
    return this._window;
  }

  constructor() {
    super();

    const ref = new WeakRef(this);
    finalizationRegistry.register(this, ref);
    managedWindows.add(ref);

    const maximizeListener = () => {
      this.disableSizeConstraints();
    };
    const unmaximizeListener = () => {
      this.enableSizeConstraints();
    };
    const enterFullScreenListener = () => {
      this.disableSizeConstraints();
    };
    const leaveFullScreenListener = () => {
      this.enableSizeConstraints();
    };

    this.on("bind", ({ data: wnd }) => {
      wnd.on("maximize", maximizeListener);
      wnd.on("unmaximize", unmaximizeListener);
      wnd.on("enter-full-screen", enterFullScreenListener);
      wnd.on("leave-full-screen", leaveFullScreenListener);

      if (getDesktopEnvironment() === DesktopEnvironment.Wayland) {
        // On Wayland, windows are actually not preserved across show / hide,
        // we will be setting their custom IDs each time they show
        wnd.on("show", () => {
          const originalTitle = wnd.title;
          wnd.setTitle("\u200B\u200C" + wnd.id);
          // Chromium/Electron store the title internally, we will be resetting the title,
          // thus Electron can remember the correct title.
          wnd.setTitle(originalTitle);
        });
      }

      wnd.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith("http://") || url.startsWith("https://")) {
          shell.openExternal(url);
        }
        return { action: "deny" };
      });

      let size: { x: number; y: number } | undefined;
      if ((size = this.getData("maximumSize"))) {
        this.setMaximumSize(size.x, size.y);
      }
      if ((size = this.getData("minimumSize"))) {
        this.setMinimumSize(size.x, size.y);
      }
      const alwaysOnTop = this.getData("alwaysOnTop");
      if (alwaysOnTop !== undefined) {
        wnd.setAlwaysOnTop(alwaysOnTop);
      }
    });

    this.on("unbind", ({ data: wnd }) => {
      wnd.off("maximize", maximizeListener);
      wnd.off("unmaximize", unmaximizeListener);
      wnd.off("enter-full-screen", enterFullScreenListener);
      wnd.off("leave-full-screen", leaveFullScreenListener);
    });
  }

  setData<K extends keyof Data>(key: K, data: Data[K]): void;
  setData<T = unknown>(key: string, data: T): void;
  setData(key: string, data: unknown): void {
    this._data[key] = data;
  }

  getData<K extends keyof Data>(key: K): Data[K] | undefined;
  getData<T = unknown>(key: string): T | undefined;
  getData(key: string): unknown | undefined {
    return this._data[key];
  }

  private enableSizeConstraints() {
    if (!this.window) return;
    const maximumSize = this.getData("maximumSize");
    if (maximumSize) {
      this.window.setMaximumSize(maximumSize.x, maximumSize.y);
    }
    const minimumSize = this.getData("minimumSize");
    if (minimumSize) {
      this.window.setMinimumSize(minimumSize.x, minimumSize.y);
    }
  }

  private disableSizeConstraints() {
    if (!this.window) return;
    const maximumSize = this.getData("maximumSize");
    if (maximumSize) {
      this.window.setMaximumSize(0, 0);
    }
    const minimumSize = this.getData("minimumSize");
    if (minimumSize) {
      this.window.setMinimumSize(0, 0);
    }
  }

  setMaximumSize(x: number, y: number) {
    x = Math.round(x);
    y = Math.round(y);
    if (this._window && shouldRespectSizeConstraints(this._window)) {
      this._window.setMaximumSize(x, y);
    }
    this.setData("maximumSize", { x, y });
  }

  setMinimumSize(x: number, y: number) {
    x = Math.round(x);
    y = Math.round(y);
    if (this._window && shouldRespectSizeConstraints(this._window)) {
      this._window.setMinimumSize(x, y);
    }
    this.setData("minimumSize", { x, y });
  }

  setAlwaysOnTop(flag: boolean) {
    if (this._window) {
      this._window.setAlwaysOnTop(flag);
    }
    this.setData("alwaysOnTop", flag);
  }

  /**
   * Sets window's input region
   *
   * Only available on Linux, for Windows and macOS, use Electron's `BrowserWindow.setIgnoreMouseEvent`.
   * @param wnd
   * @param regions
   * @returns
   */
  setWindowInputRegion(regions: InputRegion[]): boolean {
    if (os.platform() !== "linux") return false;
    const inputRegions =
      regions.length > 0
        ? regions.map((v) => ({ x: v.x, y: v.y, w: v.width, h: v.height }))
        : null;
    const doSetRegion = () => {
      if (!this._window) return false;
      if (getDesktopEnvironment() === DesktopEnvironment.Wayland) {
        return setInputRegion(this._window.id.toString(), inputRegions);
      } else {
        return setInputRegion(
          this._window.getNativeWindowHandle(),
          inputRegions
        );
      }
    };

    if (inputRegions) {
      const previousListener = this.getData<() => void>(
        "inputRegionShowListener"
      );
      if (previousListener) {
        this.off("show", previousListener);
      }
      this.setData("inputRegionShowListener", doSetRegion);
      this.on("show", doSetRegion as () => void);
    } else {
      const listener = this.getData<() => void>("inputRegionShowListener");
      if (!listener) return false;
      this.off("show", listener);
      this.setData("inputRegionShowListener", undefined);
    }

    return doSetRegion();
  }

  send(channel: string, ...args: unknown[]) {
    if (!this._window || this._window.isDestroyed()) return false;
    this._window.webContents.send(channel, ...args);
    return true;
  }

  abstract show(): void | Promise<void>;
  abstract hide(): void | Promise<void>;

  static fromBrowserWindow(browserWindow: BrowserWindow) {
    return browserManagedWindowMap.get(browserWindow);
  }
  static fromName(name: string) {
    for (const ref of managedWindows) {
      const managed = ref.deref();
      if (!managed) continue;
      if (managed.getData("name") === name) return managed;
    }
  }
}

export interface OnDemandWindowState {
  alive: boolean;
}

export class SimpleManagedWindow extends ManagedWindow {
  constructor(window: BrowserWindow) {
    super();

    // This should never be assigned again.
    this.window = window;

    window.on("show", () => this.emit("show", window));
    window.on("hide", () => this.emit("hide", window));
  }

  show() {
    this.window?.show();
  }
  hide() {
    this.window?.hide();
  }
}

export abstract class OnDemandWindow<
  T extends WindowData = WindowData,
> extends ManagedWindow<T> {
  /** State bound to the single BrowserWindow */
  protected windowState: OnDemandWindowState | null = null;

  show() {
    if (this.window && !this.window.isDestroyed()) {
      // The last window is still alive
      this.window.show();
      return;
    }
    this.windowState = {
      alive: true,
    };
    const wnd = (this.window = this.createWindow(this.windowState));
    wnd.addListener("show", () => {
      if (this.window !== wnd) return;
      this.emit("show", wnd);
    });
    wnd.addListener("hide", () => {
      if (this.window !== wnd) return;
      this.emit("hide", wnd);
      this.hide();
    });
    return new Promise<void>((resolve) => {
      const closedHandler = () => {
        resolve();
      };
      wnd.once("closed", closedHandler);
      wnd.once("ready-to-show", () => {
        wnd.off("closed", closedHandler);
        wnd.show();
        resolve();
      });
    });
  }

  hide() {
    if (this.windowState) this.windowState.alive = false;
    this.window?.close();
    this.window = null;
  }

  abstract createWindow(state: OnDemandWindowState): BrowserWindow;
}
