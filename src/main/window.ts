import os from "node:os";

import { app, BrowserWindow, shell } from "electron";
import type { BrowserWindowConstructorOptions } from "electron";
import Emittery from "emittery";

import {
  getDesktopEnvironment,
  setInputRegion,
  DesktopEnvironment,
} from "@open-orpheus/window";

import type AppMenu from "./menu";
import { LifecycleState, state as lifecycleState } from "./lifecycle";

const browserManagedWindowMap = new WeakMap<BrowserWindow, ManagedWindow>();
const managedBrowserWindows = new Set<BrowserWindow>();
const managedWindows = new Set<WeakRef<ManagedWindow>>();
const finalizationRegistry = new FinalizationRegistry<WeakRef<ManagedWindow>>(
  (held) => {
    managedWindows.delete(held);
  }
);

/**
 * Backoff used while probing for a usable platform surface after a show.
 *
 * On Wayland the surface is not guaranteed to exist by the time Electron emits
 * `show`, so state that belongs to the surface has to be re-sent until the
 * native module accepts it.
 */
const REAPPLY_DELAYS_MS = [0, 50, 100, 200, 400] as const;

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

/** The x/y/w/h shape the native input-region API expects. */
function toNativeRegions(regions: InputRegion[]) {
  return regions.length
    ? regions.map((v) => ({ x: v.x, y: v.y, w: v.width, h: v.height }))
    : null;
}

/**
 * URL for a frontend route, honouring the Vite dev server when one is running.
 *
 * `route` is a path within the renderer, e.g. `/mini-player`.
 */
export function guiUrl(route = "/"): string {
  const path = route.startsWith("/") ? route : `/${route}`;
  return GUI_VITE_DEV_SERVER_URL
    ? `${GUI_VITE_DEV_SERVER_URL}${path}`
    : `gui://frontend${path}`;
}

app.on("browser-window-created", (event, wnd) => {
  setImmediate(() => {
    if (managedBrowserWindows.has(wnd)) return;
    // A window this module did not create. Managed windows are bound
    // synchronously by `createBrowserWindow`, so this is only a safety net.
    new SimpleManagedWindow(wnd);
  });
});

/**
 * State the native module owns for a window.
 *
 * `postShow` state can be restored at any point after the surface exists, and
 * is therefore replayed whenever the surface is recreated. State that has to be
 * armed *before* the surface exists (a layer-shell role, for example) cannot be
 * replayed from a `show` event and belongs to a pre-create phase instead.
 */
interface NativeWindowState {
  postShow: {
    /** `null` = never managed, `[]` = explicitly cleared. */
    inputRegions: InputRegion[] | null;
  };
}

export abstract class ManagedWindow<
  Data extends WindowData = WindowData,
> extends Emittery<WindowEvents> {
  private _window: BrowserWindow | null = null;
  private _data: Record<string, unknown> = Object.create(null);

  private _lastOnClosedListener: (() => void) | null = null;
  private _closeNotifier: (() => void) | null = null;

  private readonly _nativeState: NativeWindowState = {
    postShow: { inputRegions: null },
  };
  /** Bumped whenever the platform surface may have been replaced. */
  private _surfaceGeneration = 0;
  private _reapplyTimer: NodeJS.Timeout | null = null;

  /**
   * The window this wrapper owns.
   *
   * Assigning binds the window (wiring it up and emitting `bind`); assigning
   * `null` releases it. Every managed window is created by
   * [`createBrowserWindow`], so a wrapper holds at most one live window.
   */
  protected set window(value: BrowserWindow | null) {
    if (this._window === value) return;
    const previous = this._window;
    if (previous) {
      managedBrowserWindows.delete(previous);
      browserManagedWindowMap.delete(previous);
      this.detachWindowListeners(previous);
      if (this._lastOnClosedListener)
        previous.off("closed", this._lastOnClosedListener);
      this.emit("unbind", previous);
    }
    this._window = value;
    if (value) {
      managedBrowserWindows.add(value);
      browserManagedWindowMap.set(value, this);
      this._lastOnClosedListener = () => this.releaseWindow(value);
      value.on("closed", this._lastOnClosedListener);
      this.attachWindowListeners(value);
      this.emit("bind", value);
    }
  }

  get window(): BrowserWindow | null {
    return this._window;
  }

  private readonly _maximizeListener = () => {
    this.disableSizeConstraints();
  };
  private readonly _unmaximizeListener = () => {
    this.enableSizeConstraints();
  };
  private readonly _enterFullScreenListener = () => {
    this.disableSizeConstraints();
  };
  private readonly _leaveFullScreenListener = () => {
    this.enableSizeConstraints();
  };
  private readonly _showListener = () => {
    const wnd = this._window;
    if (!wnd) return;
    // A new show may bring a new platform surface with it.
    this._surfaceGeneration++;
    this.reapplyNativeState();
    this.emit("show", wnd);
  };
  private readonly _hideListener = () => {
    const wnd = this._window;
    if (!wnd) return;
    this._surfaceGeneration++;
    this.cancelReapply();
    this.onWindowHidden();
    this.emit("hide", wnd);
  };
  private readonly _closeListener = (event: { preventDefault(): void }) => {
    if (
      this.isBeingDismissed() ||
      lifecycleState === LifecycleState.Quitting ||
      !this.preventsCloseRequest()
    ) {
      return;
    }
    event.preventDefault();
    this.onCloseRequested();
  };

  constructor() {
    super();

    const ref = new WeakRef(this);
    finalizationRegistry.register(this, ref);
    managedWindows.add(ref);
  }

  /**
   * Attach the listeners this wrapper owns. Called synchronously from the
   * window setter: `Emittery` delivers its events in a later microtask, which
   * is too late for wiring that must exist before the window is used.
   */
  private attachWindowListeners(wnd: BrowserWindow) {
    wnd.on("maximize", this._maximizeListener);
    wnd.on("unmaximize", this._unmaximizeListener);
    wnd.on("enter-full-screen", this._enterFullScreenListener);
    wnd.on("leave-full-screen", this._leaveFullScreenListener);
    wnd.on("show", this._showListener);
    wnd.on("hide", this._hideListener);
    wnd.on("close", this._closeListener);

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
  }

  private detachWindowListeners(wnd: BrowserWindow) {
    wnd.off("maximize", this._maximizeListener);
    wnd.off("unmaximize", this._unmaximizeListener);
    wnd.off("enter-full-screen", this._enterFullScreenListener);
    wnd.off("leave-full-screen", this._leaveFullScreenListener);
    wnd.off("show", this._showListener);
    wnd.off("hide", this._hideListener);
    wnd.off("close", this._closeListener);
  }

  /**
   * The only place a `BrowserWindow` is constructed.
   *
   * Subclasses call this instead of `new BrowserWindow` so that ownership,
   * lifetime and native state all stay in one place.
   */
  protected createBrowserWindow(
    options: BrowserWindowConstructorOptions
  ): BrowserWindow {
    const wnd = new BrowserWindow(options);
    this.window = wnd;
    return wnd;
  }

  /** The bound window, or `null` once it is gone. Never a destroyed window. */
  protected liveWindow(): BrowserWindow | null {
    const wnd = this._window;
    if (!wnd || wnd.isDestroyed()) return null;
    return wnd;
  }

  /** Load a renderer route, using the dev server when one is configured. */
  protected loadGuiRoute(route = "/"): void {
    void this.liveWindow()?.loadURL(guiUrl(route));
  }

  protected hideMenuBar(): void {
    this.liveWindow()?.setMenuBarVisibility(false);
  }

  /**
   * Ask the application before closing instead of closing directly.
   *
   * Quitting the app and dismissing the window still bypass the request, so
   * `OnDemandWindow.hide()` and `app.quit()` keep working.
   */
  protected requestCloseApproval(notify: () => void): void {
    this._closeNotifier = notify;
  }

  /** Whether a close request should be held back for [`onCloseRequested`]. */
  protected preventsCloseRequest(): boolean {
    return this._closeNotifier !== null;
  }

  /** Called when the user asks to close a window that prevents it. */
  protected onCloseRequested(): void {
    this._closeNotifier?.();
  }

  /** Whether the application itself is taking the window down. */
  protected isBeingDismissed(): boolean {
    return false;
  }

  /** Called (synchronously) when the bound window reports that it was hidden. */
  protected onWindowHidden(): void {}

  private releaseWindow(wnd: BrowserWindow) {
    if (this._window !== wnd) return;
    this.cancelReapply();
    this._surfaceGeneration++;
    browserManagedWindowMap.delete(wnd);
    this.window = null;
  }

  private cancelReapply() {
    if (this._reapplyTimer) {
      clearTimeout(this._reapplyTimer);
      this._reapplyTimer = null;
    }
  }

  private isWayland(): boolean {
    return (
      os.platform() === "linux" &&
      getDesktopEnvironment() === DesktopEnvironment.Wayland
    );
  }

  /**
   * Re-send surface-scoped state, retrying until the surface accepts it.
   *
   * The generation guard cancels work left over from a previous surface.
   */
  private reapplyNativeState() {
    if (!this.isWayland()) return;
    if (this._reapplyTimer) return;

    const generation = this._surfaceGeneration;
    let attempt = 0;
    const step = () => {
      this._reapplyTimer = null;
      if (generation !== this._surfaceGeneration) return;
      const wnd = this.liveWindow();
      if (!wnd) return;
      if (this.applyPostShowState(wnd)) return;
      if (attempt >= REAPPLY_DELAYS_MS.length) {
        console.warn(
          `[window] gave up re-applying native state for window ${wnd.id}`
        );
        return;
      }
      this._reapplyTimer = setTimeout(step, REAPPLY_DELAYS_MS[attempt++]);
    };
    step();
  }

  /** Returns whether the surface was ready to accept the state. */
  private applyPostShowState(wnd: BrowserWindow): boolean {
    // On Wayland windows are not preserved across show / hide, so the custom id
    // the native module uses to name this window has to be re-sent each time.
    const originalTitle = wnd.title;
    wnd.setTitle("\u200B\u200C" + wnd.id);
    // Chromium/Electron store the title internally, we will be resetting the title,
    // thus Electron can remember the correct title.
    wnd.setTitle(originalTitle);

    const regions = this._nativeState.postShow.inputRegions;
    if (regions === null) return true;
    // A known window id is what makes the input region land; the native module
    // reports failure until the surface exists, which is our readiness probe.
    return setInputRegion(wnd.id.toString(), toNativeRegions(regions));
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
    const wnd = this.liveWindow();
    if (!wnd) return;
    const maximumSize = this.getData("maximumSize");
    if (maximumSize) {
      wnd.setMaximumSize(maximumSize.x, maximumSize.y);
    }
    const minimumSize = this.getData("minimumSize");
    if (minimumSize) {
      wnd.setMinimumSize(minimumSize.x, minimumSize.y);
    }
  }

  private disableSizeConstraints() {
    const wnd = this.liveWindow();
    if (!wnd) return;
    const maximumSize = this.getData("maximumSize");
    if (maximumSize) {
      wnd.setMaximumSize(0, 0);
    }
    const minimumSize = this.getData("minimumSize");
    if (minimumSize) {
      wnd.setMinimumSize(0, 0);
    }
  }

  setMaximumSize(x: number, y: number) {
    x = Math.round(x);
    y = Math.round(y);
    const wnd = this.liveWindow();
    if (wnd && shouldRespectSizeConstraints(wnd)) {
      wnd.setMaximumSize(x, y);
    }
    this.setData("maximumSize", { x, y });
  }

  setMinimumSize(x: number, y: number) {
    x = Math.round(x);
    y = Math.round(y);
    const wnd = this.liveWindow();
    if (wnd && shouldRespectSizeConstraints(wnd)) {
      wnd.setMinimumSize(x, y);
    }
    this.setData("minimumSize", { x, y });
  }

  setAlwaysOnTop(flag: boolean) {
    this.liveWindow()?.setAlwaysOnTop(flag);
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
    this._nativeState.postShow.inputRegions = regions;

    const wnd = this.liveWindow();
    if (!wnd) return false;
    const native = toNativeRegions(regions);
    if (this.isWayland()) {
      return setInputRegion(wnd.id.toString(), native);
    }
    return setInputRegion(wnd.getNativeWindowHandle(), native);
  }

  send(channel: string, ...args: unknown[]) {
    const wnd = this.liveWindow();
    if (!wnd) return false;
    wnd.webContents.send(channel, ...args);
    return true;
  }

  show(): void | Promise<void> {
    this.liveWindow()?.show();
  }

  hide(): void | Promise<void> {
    this.liveWindow()?.hide();
  }

  /** Dismiss the bound window, bypassing the close policy. */
  destroy(): void {
    this.liveWindow()?.destroy();
  }

  /**
   * Hand everything this wrapper recorded to `target`.
   *
   * Move semantics: the source keeps nothing, so a discarded wrapper can no
   * longer be found by [`ManagedWindow.fromName`] or re-apply stale state.
   * Event subscribers are not carried over; consumers follow the module's live
   * `window` binding instead.
   */
  transferStateTo(target: ManagedWindow): void {
    const merged: Record<string, unknown> = Object.create(null);
    Object.assign(merged, target._data, this._data);
    target._data = merged;
    target._nativeState.postShow = this._nativeState.postShow;
    this._data = Object.create(null);
    this._nativeState.postShow = { inputRegions: null };
  }

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

/**
 * A managed window this module did not create.
 *
 * Managed windows are constructed by [`ManagedWindow.createBrowserWindow`] and
 * are bound synchronously; this wrapper only exists for windows Electron itself
 * produced.
 */
export class SimpleManagedWindow extends ManagedWindow {
  constructor(window: BrowserWindow) {
    super();

    // This should never be assigned again.
    this.window = window;
  }
}

/**
 * A managed window with no lifecycle policy of its own.
 *
 * For short-lived windows (a `chrome://` info window, a renderer-requested
 * URL) that only need to be created through the wrapper.
 */
export class BasicManagedWindow extends ManagedWindow {
  constructor(options: BrowserWindowConstructorOptions) {
    super();
    this.createBrowserWindow(options);
  }
}

export abstract class OnDemandWindow<
  T extends WindowData = WindowData,
> extends ManagedWindow<T> {
  /** State bound to the single BrowserWindow */
  protected windowState: OnDemandWindowState | null = null;

  protected isBeingDismissed(): boolean {
    return this.windowState !== null && !this.windowState.alive;
  }

  // A window that hides itself is dismissed; `show()` recreates it.
  protected onWindowHidden(): void {
    this.hide();
  }

  show() {
    const existing = this.liveWindow();
    if (existing) {
      // The last window is still alive
      existing.show();
      return;
    }
    this.windowState = {
      alive: true,
    };
    const wnd = this.createWindow(this.windowState);
    if (this.window !== wnd) this.window = wnd;
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
    this.liveWindow()?.close();
    this.window = null;
  }

  abstract createWindow(state: OnDemandWindowState): BrowserWindow;
}

/**
 * Move a window to the other lifecycle policy.
 *
 * The bound window is dismissed and recreated by `create`; everything the
 * wrapper recorded (`name`, size limits, always-on-top, native input regions)
 * moves to the replacement. A window that was on screen is shown again, so the
 * switch is only visible as a re-created window, not as a disappearing one.
 */
export function switchWindowPolicy(
  current: ManagedWindow | null,
  create: () => ManagedWindow
): ManagedWindow {
  const wasVisible = current?.window?.isVisible() ?? false;
  current?.destroy();
  const next = create();
  current?.transferStateTo(next);
  if (wasVisible) {
    void next.show();
  }
  return next;
}
