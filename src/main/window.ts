import { app, BrowserWindow, shell } from "electron";
import type { BrowserWindowConstructorOptions } from "electron";
import Emittery from "emittery";
import { merge } from "es-toolkit";

import {
  decorateWindowTitle,
  drainWindowCallbacks,
  forgetWindowState,
  getDesktopEnvironment,
  isLayerShellAvailable,
  onLayerShellRoleRefused,
  setInputRegion,
  setWindowLayerShell,
  transferWindowState,
  validateLayerShellOptions,
  DesktopEnvironment,
} from "@open-orpheus/window";
import type { LayerShellOptions } from "@open-orpheus/window";

export type { LayerShellOptions };

import type AppMenu from "./menu";
import {
  events as lifecycleEvents,
  LifecycleState,
  registerShutdownFinalizer,
  state as lifecycleState,
} from "./lifecycle";
import { toError } from "../util";

const browserManagedWindowMap = new WeakMap<BrowserWindow, ManagedWindow>();
const managedBrowserWindows = new Set<BrowserWindow>();
const managedWindows = new Set<WeakRef<ManagedWindow>>();
/**
 * Names managed windows for the native layer.
 *
 * Generated here rather than taken from Electron, because it has to be known
 * before the window — and therefore before its surface — exists.
 */
let nextManagedWindowId = 1;
const finalizationRegistry = new FinalizationRegistry<{
  ref: WeakRef<ManagedWindow>;
  id: string;
}>((held) => {
  managedWindows.delete(held.ref);
  // A discarded wrapper must not leave recorded native state behind. Ids are
  // never reused, so this can only affect a window that is already gone.
  try {
    forgetWindowState(held.id);
  } catch {
    // The native module can already be gone while the process tears down.
  }
});

/** Reap completed native callbacks on the JS thread, including while idle. */
const CALLBACK_REAP_INTERVAL_MS = 50;

// A callback can retire just after its final cancellation. Reap independently
// of new menu activity; this timer must not keep the application alive.
const callbackReaper = setInterval(() => drainWindowCallbacks(), CALLBACK_REAP_INTERVAL_MS);
callbackReaper.unref();
// Keep reaping while shutdown tasks dispose their resources. A finalizer also
// runs on signal-driven app.exit(), and cannot be skipped by the task deadline.
registerShutdownFinalizer({
  name: "window-callbacks",
  run: () => {
    clearInterval(callbackReaper);
    drainWindowCallbacks();
  },
});

export let mainWindow: BrowserWindow | null = null;

/**
 * Take every window off screen as soon as the app starts shutting down, so the
 * app looks closed while the shutdown tasks run.
 *
 * The raw `BrowserWindow` is hidden rather than the wrapper, because
 * `OnDemandWindow.hide()` is the explicit dismiss and closes the window
 * outright. Hiding still reaches the wrapper through Electron's `hide` event,
 * which is why `OnDemandWindow.onWindowHidden` declines to destroy while the
 * app is quitting. The final `app.quit()` does the real teardown.
 */
lifecycleEvents.on("quitting", () => {
  for (const ref of managedWindows) {
    ref.deref()?.window?.hide();
  }
});

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
  /**
   * The compositor refused the layer-shell role for this window.
   *
   * A surface's role is never released, so this happens when the window's
   * surface took an ordinary toplevel role before its policy was seen. It
   * cannot be fixed on that surface: whatever handles this has to re-create the
   * window, which is the only way to get a surface that can still take the
   * role.
   */
  layerShellRefused: BrowserWindow;
}

export type WindowData = {
  name: string;
  maximumSize: { x: number; y: number };
  minimumSize: { x: number; y: number };
  alwaysOnTop: boolean;
  menu: AppMenu | undefined;
};

function shouldRespectSizeConstraints(wnd: BrowserWindow) {
  return !wnd.isMaximized() && !wnd.isFullScreen();
}

/** The x/y/w/h shape the native input-region API expects. */
function toNativeRegions(regions: InputRegion[]) {
  return regions.length ? regions.map((v) => ({ x: v.x, y: v.y, w: v.width, h: v.height })) : null;
}

/**
 * URL for a frontend route, honouring the Vite dev server when one is running.
 *
 * `route` is a path within the renderer, e.g. `/mini-player`.
 */
export function guiUrl(route = "/"): string {
  const path = route.startsWith("/") ? route : `/${route}`;
  return GUI_VITE_DEV_SERVER_URL ? `${GUI_VITE_DEV_SERVER_URL}${path}` : `gui://frontend${path}`;
}

app.on("browser-window-created", (event, wnd) => {
  setImmediate(() => {
    // A short-lived probe may already have closed and released its binding.
    if (wnd.isDestroyed() || managedBrowserWindows.has(wnd)) return;
    // A window this module did not create. Managed windows are bound
    // synchronously by `createBrowserWindow`, so this is only a safety net.
    new SimpleManagedWindow(wnd);
  });
});

// A window whose layer-shell role was refused can only be fixed by re-creating
// it, so the native layer's report has to reach the application. Registered
// once, when the session is known.
void app.whenReady().then(() => {
  if (getDesktopEnvironment() !== DesktopEnvironment.Wayland) return;
  onLayerShellRoleRefused((windowId: string) => {
    const managed = ManagedWindow.fromId(windowId);
    const wnd = managed?.window;
    if (managed && wnd) void managed.emit("layerShellRefused", wnd);
  });
});

export abstract class ManagedWindow<
  Data extends WindowData = WindowData,
> extends Emittery<WindowEvents> {
  /** The name the native layer knows this window by. */
  readonly id = String(nextManagedWindowId++);

  private _window: BrowserWindow | null = null;
  private _data: Record<string, unknown> = Object.create(null);
  private _title = "";

  private _lastOnClosedListener: (() => void) | null = null;
  private _closeNotifier: (() => void) | null = null;
  private _menuCloseUnsubscribe: (() => void) | null = null;

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
      this.setMenu(undefined);
      managedBrowserWindows.delete(previous);
      browserManagedWindowMap.delete(previous);
      this.detachWindowListeners(previous);
      if (this._lastOnClosedListener) previous.off("closed", this._lastOnClosedListener);
      void this.emit("unbind", previous);
    }
    this._window = value;
    if (value) {
      managedBrowserWindows.add(value);
      browserManagedWindowMap.set(value, this);
      this._lastOnClosedListener = () => this.releaseWindow(value);
      value.on("closed", this._lastOnClosedListener);
      this.attachWindowListeners(value);
      void this.emit("bind", value);
    }
  }

  get window(): BrowserWindow | null {
    return this._window;
  }

  /** The window's title. The window itself is never asked for it. */
  get title(): string {
    return this._title;
  }

  /**
   * Set the window's title.
   *
   * This is the only way the title is ever written: the native layer keys the
   * window on the id that rides in front of it, so a title written straight to
   * the `BrowserWindow` would drop that id and with it the window's name.
   */
  setTitle(title: string): void {
    this._title = title;
    this.applyTitle();
  }

  /** What the native layer expects to see on the wire for this window. */
  private decoratedTitle(): string {
    // Only Wayland strips the id out again; elsewhere the decoration would show
    // up in the window title (invisible characters plus a visible number).
    return this.isWayland() ? decorateWindowTitle(this.id, this._title) : this._title;
  }

  private applyTitle(): void {
    this.liveWindow()?.setTitle(this.decoratedTitle());
  }

  /**
   * The page must not write the window title on Wayland.
   *
   * The managed id rides in the title, so a page title would either carry no id
   * or carry someone else's; it is taken, prevented, and written back by this
   * module instead. Attached only where the title is decorated.
   */
  private readonly _pageTitleListener = (event: Electron.Event, title: string) => {
    if (event.defaultPrevented) return; // Someone already handled this.
    event.preventDefault();
    if (title === this.decoratedTitle()) return;
    this.setTitle(title);
  };

  private readonly _maximizeListener = () => {
    this.setMenu(undefined);
    this.disableSizeConstraints();
  };
  private readonly _unmaximizeListener = () => {
    this.setMenu(undefined);
    this.enableSizeConstraints();
  };
  private readonly _enterFullScreenListener = () => {
    this.setMenu(undefined);
    this.disableSizeConstraints();
  };
  private readonly _leaveFullScreenListener = () => {
    this.setMenu(undefined);
    this.enableSizeConstraints();
  };
  // A popup's anchor belongs to the layout at opening time. Close the parent
  // window's menu rather than retaining that anchor after a layout resize.
  private readonly _resizeListener = () => {
    this.setMenu(undefined);
  };
  private readonly _showListener = () => {
    const wnd = this._window;
    if (!wnd) return;
    void this.emit("show", wnd);
  };
  private readonly _hideListener = () => {
    const wnd = this._window;
    if (!wnd) return;
    this.setMenu(undefined);
    this.onWindowHidden();
    void this.emit("hide", wnd);
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
    finalizationRegistry.register(this, { ref, id: this.id });
    managedWindows.add(ref);
  }

  /**
   * Attach the listeners this wrapper owns. Called synchronously from the
   * window setter: `Emittery` delivers its events in a later microtask, which
   * is too late for wiring that must exist before the window is used.
   */
  private attachWindowListeners(wnd: BrowserWindow) {
    wnd.on("resize", this._resizeListener);
    wnd.on("maximize", this._maximizeListener);
    wnd.on("unmaximize", this._unmaximizeListener);
    wnd.on("enter-full-screen", this._enterFullScreenListener);
    wnd.on("leave-full-screen", this._leaveFullScreenListener);
    wnd.on("show", this._showListener);
    wnd.on("hide", this._hideListener);
    wnd.on("close", this._closeListener);
    // Only Wayland puts the managed id in the title, so only there does the page
    // have to be kept from writing it. Elsewhere the title stays Electron's.
    if (this.isWayland()) {
      wnd.on("page-title-updated", this._pageTitleListener);
    }

    wnd.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("http://") || url.startsWith("https://")) {
        void shell.openExternal(url);
        LOGGER.debug({ windowId: this.id }, "Opened external link in the default browser");
      } else {
        const separator = url.indexOf(":");
        LOGGER.warn(
          {
            windowId: this.id,
            scheme: separator > 0 ? url.slice(0, separator) : "unknown",
          },
          "Blocked window open request with an unsupported scheme"
        );
      }
      return { action: "deny" };
    });

    this.applyRecordedState(wnd);
  }

  /**
   * Apply the state this wrapper recorded to `wnd`.
   *
   * Called when a window is bound, and again when state moves to a window that
   * is already bound: a policy switch creates its replacement eagerly, so the
   * state arrives after that window exists.
   */
  private applyRecordedState(wnd: BrowserWindow) {
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
    wnd.off("resize", this._resizeListener);
    wnd.off("maximize", this._maximizeListener);
    wnd.off("unmaximize", this._unmaximizeListener);
    wnd.off("enter-full-screen", this._enterFullScreenListener);
    wnd.off("leave-full-screen", this._leaveFullScreenListener);
    wnd.off("show", this._showListener);
    wnd.off("hide", this._hideListener);
    wnd.off("close", this._closeListener);
    wnd.off("page-title-updated", this._pageTitleListener);
  }

  /**
   * The only place a `BrowserWindow` is constructed.
   *
   * Subclasses call this instead of `new BrowserWindow` so that ownership,
   * lifetime and native state all stay in one place. A window class that is a
   * layer surface registers its policy with [`setLayerShell`] before calling
   * this, so the policy is in place before the window — and therefore its first
   * role object — exists.
   */
  protected createBrowserWindow(options: BrowserWindowConstructorOptions): BrowserWindow {
    if (this._window) this.window = null;
    // Supply the decorated title from the first native role initialization,
    // not only after construction: the proxy needs the id to select its role.
    const { title, ...rest } = options;
    if (title !== undefined) this._title = title;
    let wnd: BrowserWindow;
    try {
      wnd = new BrowserWindow(
        merge(merge({}, rest), {
          title: this.decoratedTitle(),
          webPreferences: { disableWakeLocks: true },
        })
      );
    } catch (error) {
      // The policy may have been registered before the window existed; a window
      // that was never created must not leave one behind.
      if (this.isWayland()) setWindowLayerShell(this.id, null);
      LOGGER.error({ err: toError(error), windowId: this.id }, "Failed to create managed window");
      throw error;
    }
    this.window = wnd;
    this.applyTitle();
    LOGGER.debug({ windowId: this.id }, "Managed window created");
    return wnd;
  }

  /** Whether the compositor can take layer surfaces at all. */
  static isLayerShellAvailable(): boolean {
    return getDesktopEnvironment() === DesktopEnvironment.Wayland && isLayerShellAvailable();
  }

  /**
   * Register the layer-shell policy this window should take, or clear it with
   * `null`.
   *
   * Call this before the window is created: the native layer keys the policy on
   * this window's id and consults it once, when the surface's role is decided,
   * and a role can be taken inside `new BrowserWindow` when the window is
   * created shown. A compositor assigns a surface's role once and never changes
   * it, so a window that is already a layer surface stays one for as long as its
   * surface lives, and `null` only takes effect once the window is recreated.
   *
   * The wrapper keeps no copy: the native layer owns the state, and
   * [`transferStateTo`] re-keys it when a policy switch replaces the window.
   *
   * Returns whether the policy could be sent at all; `false` means the
   * compositor cannot take layer surfaces or the options are unsendable, and
   * this window will be an ordinary toplevel.
   */
  setLayerShell(options: LayerShellOptions | null): boolean {
    if (!this.isWayland()) return options === null;
    setWindowLayerShell(this.id, options);
    if (options === null) return true;
    return ManagedWindow.isLayerShellAvailable() && validateLayerShellOptions(options);
  }

  /**
   * Release the native state this wrapper recorded (its layer-shell policy and
   * input region).
   *
   * Call it when the wrapper will not be used again. A window that merely hides
   * and is shown later keeps its id and must not call this: the native layer
   * needs the record for the surface it creates next. A discarded wrapper is
   * released automatically when it is collected; this is for callers that want
   * it to happen now.
   */
  releaseNativeState(): void {
    forgetWindowState(this.id);
  }

  /** The bound window, or `null` once it is gone. Never a destroyed window. */
  protected liveWindow(): BrowserWindow | null {
    const wnd = this._window;
    if (!wnd || wnd.isDestroyed()) return null;
    return wnd;
  }

  /**
   * Whether the window is on screen or has been asked to appear.
   *
   * A policy switch asks this rather than `isVisible()`: an on-demand window
   * that was shown but has not reached `ready-to-show` yet is not visible, and
   * treating that as "hidden" would drop the request along with the old window.
   */
  wantsToBeVisible(): boolean {
    return this.liveWindow()?.isVisible() ?? false;
  }

  /** Load a renderer route, using the dev server when one is configured. */
  protected loadGuiRoute(route = "/"): void {
    const wnd = this.liveWindow();
    if (!wnd) return;
    LOGGER.debug({ windowId: this.id, route }, "Loading window route");
    void wnd.loadURL(guiUrl(route)).catch((error) => {
      LOGGER.error(
        { err: toError(error), windowId: this.id, route },
        "Failed to load window route"
      );
    });
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
    browserManagedWindowMap.delete(wnd);
    this.window = null;
    LOGGER.debug({ windowId: this.id }, "Managed window closed");
  }

  /**
   * Whether the session is Wayland.
   */
  private isWayland(): boolean {
    return getDesktopEnvironment() === DesktopEnvironment.Wayland;
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

  /** Replace the menu owned by this window and dispose the previous one. */
  setMenu(menu: AppMenu | undefined) {
    const previous = this.getData("menu");
    if (previous === menu) return;

    this._menuCloseUnsubscribe?.();
    this._menuCloseUnsubscribe = null;
    this.setData("menu", menu);
    previous?.close();

    if (menu) {
      this._menuCloseUnsubscribe = menu.on("close", () => {
        if (this.getData("menu") !== menu) return;
        this._menuCloseUnsubscribe?.();
        this._menuCloseUnsubscribe = null;
        this.setData("menu", undefined);
      });
    }
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
   * Set the regions this window receives input in.
   *
   * Only available on Linux; on Windows and macOS use Electron's
   * `BrowserWindow.setIgnoreMouseEvents`.
   *
   * On Wayland the native layer owns the region: it records it against the
   * window id and emits it immediately before the surface's next commit, since
   * a `set_input_region` is only adopted at a commit. The return value
   * therefore means "recorded", not "already in effect".
   */
  setWindowInputRegion(regions: InputRegion[]): boolean {
    const native = toNativeRegions(regions);

    if (this.isWayland()) {
      return setInputRegion(this.id, native);
    }

    const wnd = this.liveWindow();
    if (!wnd) return false;
    return setInputRegion(wnd.getNativeWindowHandle(), native);
  }

  send(channel: string, ...args: unknown[]) {
    const wnd = this.liveWindow();
    if (!wnd) return false;
    wnd.webContents.send(channel, ...args);
    return true;
  }

  show(): void | Promise<void> {
    // The native layer applies the window's registered policy when its surface
    // takes a role, so this stays a plain forward.
    const wnd = this.liveWindow();
    if (!wnd) return;
    LOGGER.debug({ windowId: this.id }, "Managed window shown");
    wnd.show();
  }

  hide(): void | Promise<void> {
    const wnd = this.liveWindow();
    if (!wnd) return;
    LOGGER.debug({ windowId: this.id }, "Managed window hidden");
    wnd.hide();
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
    // A popup belongs to the old surface, not to the replacement wrapper.
    this.setMenu(undefined);
    target.setMenu(undefined);
    const merged: Record<string, unknown> = Object.create(null);
    Object.assign(merged, target._data, this._data);
    target._data = merged;
    target.setTitle(this._title);
    this._data = Object.create(null);
    // Native state is keyed by window id, so the native layer re-keys its own:
    // the discarded id keeps nothing and the replacement owns what it held.
    if (this.isWayland()) transferWindowState(this.id, target.id);
    // A target that already has a window was bound before this state arrived,
    // so nothing else would apply the rest of it.
    const wnd = target.liveWindow();
    if (wnd) target.applyRecordedState(wnd);
  }

  static fromBrowserWindow(browserWindow: BrowserWindow) {
    return browserManagedWindowMap.get(browserWindow);
  }
  static fromId(id: string) {
    for (const ref of managedWindows) {
      const managed = ref.deref();
      if (managed?.id === id) return managed;
    }
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

export abstract class OnDemandWindow<T extends WindowData = WindowData> extends ManagedWindow<T> {
  /** State bound to the single BrowserWindow */
  protected windowState: OnDemandWindowState | null = null;

  protected isBeingDismissed(): boolean {
    return this.windowState !== null && !this.windowState.alive;
  }

  /**
   * A pending first show counts: the window exists, it is just not on screen
   * yet, and the show request is what a policy switch has to carry over.
   */
  wantsToBeVisible(): boolean {
    return this.windowState?.alive === true;
  }

  // A window that hides itself is dismissed; `show()` recreates it.
  protected onWindowHidden(): void {
    // Except while the app is shutting down, where windows are taken off
    // screen only so the app looks closed. Destroying one here would leave a
    // shutdown task unable to reach its renderer, so the window stays bound
    // until the `app.quit()` that ends the sequence closes it for real.
    if (lifecycleState === LifecycleState.Quitting) return;
    this.hide();
  }

  show() {
    const existing = this.liveWindow();
    if (existing) {
      // The last window is still alive
      LOGGER.debug({ windowId: this.id }, "Revealed existing on-demand window");
      existing.show();
      return;
    }
    this.windowState = {
      alive: true,
    };
    // This show creates the surface, whose role the native layer decides from
    // the policy `createWindow` registered through `createBrowserWindow`.
    const wnd = this.createWindow(this.windowState);
    if (this.window !== wnd) this.window = wnd;
    return new Promise<void>((resolve) => {
      const closedHandler = () => {
        resolve();
      };
      wnd.once("closed", closedHandler);
      wnd.once("ready-to-show", () => {
        wnd.off("closed", closedHandler);
        LOGGER.debug({ windowId: this.id }, "On-demand window ready to show");
        wnd.show();
        resolve();
      });
    });
  }

  hide() {
    if (this.windowState) this.windowState.alive = false;
    this.liveWindow()?.close();
    this.window = null;
    LOGGER.debug({ windowId: this.id }, "Dismissed on-demand window");
  }

  abstract createWindow(state: OnDemandWindowState): BrowserWindow;
}

/**
 * Move a window to the other lifecycle policy.
 *
 * The bound window is dismissed and recreated by `create`; everything the
 * wrapper recorded (`name`, size limits, always-on-top, native input regions)
 * moves to the replacement, and so do the position and size it currently has —
 * a window the user moved or resized comes back where it was. A window that was
 * on screen, or was waiting to appear, is shown again, so the switch is only
 * visible as a re-created window, not as a disappearing one.
 *
 * The layer-shell policy moves with the rest. A window class that registers its
 * own policy does it for the surface it creates, so the replacement is a layer
 * surface right away; policy registered on the discarded wrapper is carried
 * over to the replacement's id, and can only take effect on the surface the
 * replacement creates afterwards, because `create` has already built one by the
 * time the hand-off happens.
 */
export function switchWindowPolicy(
  current: ManagedWindow | null,
  create: () => ManagedWindow
): ManagedWindow {
  const bounds = current?.window?.getBounds();
  const wasVisible = current?.wantsToBeVisible() ?? false;
  current?.destroy();
  const next = create();
  LOGGER.debug(
    { previousWindowId: current?.id, windowId: next.id, wasVisible },
    "Switched window lifecycle policy"
  );
  current?.transferStateTo(next);
  // After the state has moved: the replacement may have been created already.
  if (bounds && next.window) {
    next.window.setBounds(bounds);
  }
  if (wasVisible) {
    void next.show();
  }
  return next;
}
