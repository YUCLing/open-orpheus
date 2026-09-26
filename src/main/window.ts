import { app, BrowserWindow, shell } from "electron";
import type { BrowserWindowConstructorOptions } from "electron";
import Emittery from "emittery";

import {
  cancelLayerShellForNextWindow,
  decorateWindowTitle,
  getDesktopEnvironment,
  isLayerShellAvailable,
  onLayerShellRoleRefused,
  setInputRegion,
  useLayerShellForNextWindow,
  validateLayerShellOptions,
  DesktopEnvironment,
} from "@open-orpheus/window";
import type { LayerShellOptions } from "@open-orpheus/window";

export type { LayerShellOptions };

import type AppMenu from "./menu";
import { LifecycleState, state as lifecycleState } from "./lifecycle";

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
  /**
   * The compositor refused the layer-shell role for this window.
   *
   * A surface's role is never released, so this happens when the window was
   * already an ordinary toplevel when the declaration reached it. It cannot be
   * fixed on that surface: whatever handles this has to re-create the window,
   * which is the only way to get a surface that can still take the role.
   */
  layerShellRefused: BrowserWindow;
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

// A window whose layer-shell role was refused can only be fixed by re-creating
// it, so the native layer's report has to reach the application. Registered
// once, when the session is known.
app.whenReady().then(() => {
  if (getDesktopEnvironment() !== DesktopEnvironment.Wayland) return;
  onLayerShellRoleRefused((windowId: string) => {
    const managed = ManagedWindow.fromId(windowId);
    const wnd = managed?.window;
    if (managed && wnd) managed.emit("layerShellRefused", wnd);
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
  /**
   * State that has to be armed before the surface exists, because a compositor
   * assigns a surface's role once and never lets it change.
   */
  preCreate: {
    layerShell: LayerShellOptions | null;
  };
}

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

  private readonly _nativeState: NativeWindowState = {
    postShow: { inputRegions: null },
    preCreate: { layerShell: null },
  };
  /** The window's own show methods, while this wrapper has them wrapped. */
  private _originalShow: (() => void) | null = null;
  private _originalShowInactive: (() => void) | null = null;
  /** Bumped whenever the platform surface may have been replaced. */
  private _surfaceGeneration = 0;
  private _reapplyTimer: NodeJS.Timeout | null = null;
  /**
   * A layer-shell declaration is in flight for this window's next surface.
   *
   * The native queue is positional and hands declarations out oldest first, so
   * exactly one may be outstanding per surface: a second one would be claimed
   * by whichever window creates the next surface instead. Cleared by the next
   * visibility change, which is when the surface exists or is gone.
   */
  private _layerShellDeclared = false;

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
    return this.isWayland()
      ? decorateWindowTitle(this.id, this._title)
      : this._title;
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
  private readonly _pageTitleListener = (
    event: { preventDefault(): void },
    title: string
  ) => {
    event.preventDefault();
    if (title === this.decoratedTitle()) return;
    this.setTitle(title);
  };

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
    // Whatever was declared for this surface has been claimed by now.
    this._layerShellDeclared = false;
    this.reapplyNativeState();
    this.emit("show", wnd);
  };
  private readonly _hideListener = () => {
    const wnd = this._window;
    if (!wnd) return;
    this._surfaceGeneration++;
    // The next show brings a new surface, which needs its own declaration.
    this._layerShellDeclared = false;
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
    // Only Wayland puts the managed id in the title, so only there does the page
    // have to be kept from writing it. Elsewhere the title stays Electron's.
    if (this.isWayland()) {
      wnd.on("page-title-updated", this._pageTitleListener);
    }

    // A window's role is taken from whichever show creates (or re-creates) its
    // surface, and other modules show windows straight through the
    // `BrowserWindow` — `menu.ts`, the `winhelper.*` calls, `app.ts`. Wrapping
    // the two show methods here is what makes the layer-shell declaration
    // unmissable, instead of depending on every caller going through this
    // wrapper.
    this._originalShow = wnd.show.bind(wnd);
    wnd.show = () => {
      this.armLayerShellForShow(wnd);
      this._originalShow?.();
    };
    this._originalShowInactive = wnd.showInactive.bind(wnd);
    wnd.showInactive = () => {
      this.armLayerShellForShow(wnd);
      this._originalShowInactive?.();
    };

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
    wnd.off("page-title-updated", this._pageTitleListener);

    if (this._originalShow) wnd.show = this._originalShow;
    if (this._originalShowInactive)
      wnd.showInactive = this._originalShowInactive;
    this._originalShow = null;
    this._originalShowInactive = null;
  }

  /**
   * The only place a `BrowserWindow` is constructed.
   *
   * Subclasses call this instead of `new BrowserWindow` so that ownership,
   * lifetime and native state all stay in one place. A window created shown
   * brings its surface with it, so the layer-shell declaration is armed here;
   * one created hidden has no surface until its first show, which arms it.
   */
  protected createBrowserWindow(
    options: BrowserWindowConstructorOptions
  ): BrowserWindow {
    // A new window is a new surface: nothing is in flight for it.
    this._layerShellDeclared = false;
    this.beforeSurfaceCreated();
    if (options.show !== false) this.armLayerShell();
    // The title is ours to write, because the managed id rides in it: it is
    // never handed to the constructor, where nothing would decorate it.
    const { title, ...rest } = options;
    if (title !== undefined) this._title = title;
    const wnd = new BrowserWindow(rest);
    this.window = wnd;
    this.applyTitle();
    return wnd;
  }

  /** Whether the compositor can take layer surfaces at all. */
  static isLayerShellAvailable(): boolean {
    return (
      getDesktopEnvironment() === DesktopEnvironment.Wayland &&
      isLayerShellAvailable()
    );
  }

  /**
   * Record the layer-shell state this window should take, or clear it with
   * `null`.
   *
   * Nothing is sent to the compositor here. A declaration can only be honoured
   * while a surface is being created, because a compositor assigns a surface's
   * role once and never changes it: the recorded state is armed for the
   * creation itself, or for the show that brings the surface, and nowhere else.
   * A window that is already a layer surface stays one for as long as its
   * surface lives, so `null` only takes effect once the window is recreated.
   *
   * Returns whether the declaration could be sent at all; `false` means the
   * compositor cannot take layer surfaces or the options are unsendable, and
   * this window will be an ordinary toplevel.
   */
  setLayerShell(options: LayerShellOptions | null): boolean {
    this._nativeState.preCreate.layerShell = options;
    if (options === null) {
      // Withdraw a declaration that is still in flight, so it cannot convert a
      // surface this window no longer wants.
      if (this._layerShellDeclared) this.cancelLayerShell();
      this._layerShellDeclared = false;
      return true;
    }
    return (
      ManagedWindow.isLayerShellAvailable() &&
      validateLayerShellOptions(options)
    );
  }

  /** The layer-shell state this window declares, if any. */
  get layerShell(): LayerShellOptions | null {
    return this._nativeState.preCreate.layerShell;
  }

  /**
   * Declare layer-shell state for the surface this window is about to create.
   *
   * Called by [`createBrowserWindow`] immediately before the `BrowserWindow`
   * exists, which is the only moment a role can be taken. Subclasses that are
   * layer surfaces override this and call [`setLayerShell`], so the state is
   * recorded no matter whether the surface arrives with the creation or with
   * the first show — the declaration queue is positional, and it is only ever
   * armed for a surface that is about to be created.
   */
  protected beforeSurfaceCreated(): void {}

  /**
   * Arm the recorded state before a show that may bring a surface.
   *
   * Called from the wrapped `show`/`showInactive`, so it does not matter which
   * module asks for the window to appear.
   */
  private armLayerShellForShow(wnd: BrowserWindow): void {
    if (!wnd.isVisible()) this.armLayerShell();
  }

  /**
   * Arm the recorded layer-shell state for the surface about to be created.
   *
   * Called immediately before an action that brings a surface with it — a
   * creation, or a show of a hidden window — and nowhere else. The queue is
   * positional, so a declaration armed while no surface follows is handed to
   * whichever window creates the next one.
   */
  protected armLayerShell(): boolean {
    const options = this._nativeState.preCreate.layerShell;
    if (!options) return false;
    if (this._layerShellDeclared) return true;
    const accepted = useLayerShellForNextWindow(options);
    this._layerShellDeclared = accepted;
    return accepted;
  }

  private cancelLayerShell(): void {
    cancelLayerShellForNextWindow();
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

  /**
   * Whether the session is Wayland.
   */
  private isWayland(): boolean {
    return getDesktopEnvironment() === DesktopEnvironment.Wayland;
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
      if (this.applyPostShowState()) return;
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
  private applyPostShowState(): boolean {
    const regions = this._nativeState.postShow.inputRegions;
    if (regions === null) return true;
    // The managed id is on the wire from the prologue on, so this lands as soon
    // as the surface exists; the native module reports failure until then,
    // which is our readiness probe.
    return setInputRegion(this.id, toNativeRegions(regions));
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
    this._nativeState.postShow.inputRegions = regions;

    const wnd = this.liveWindow();
    if (!wnd) return false;
    const native = toNativeRegions(regions);
    if (this.isWayland()) {
      return setInputRegion(this.id, native);
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
    // The window's own `show` arms the declaration first (see
    // `attachWindowListeners`), so this stays a plain forward.
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
    target._nativeState.preCreate = this._nativeState.preCreate;
    target.setTitle(this._title);
    this._data = Object.create(null);
    this._nativeState.postShow = { inputRegions: null };
    this._nativeState.preCreate = { layerShell: null };
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
    // This show creates the surface, and `createWindow` declares the role for
    // it through `createBrowserWindow`.
    const wnd = this.createWindow(this.windowState);
    if (this.window !== wnd) this.window = wnd;
    return new Promise<void>((resolve) => {
      const closedHandler = () => {
        resolve();
      };
      wnd.once("closed", closedHandler);
      wnd.once("ready-to-show", () => {
        wnd.off("closed", closedHandler);
        // This show is what creates the surface, and the window's own `show`
        // arms the declaration for it.
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
 *
 * Pre-create state (a layer-shell declaration) moves too. A window class that
 * declares its own layer-shell state does it for the surface it creates, so the
 * replacement is a layer surface right away; state recorded by a caller on the
 * discarded wrapper can only take effect on the surface the replacement creates
 * afterwards, because `create` has already built one by the time the hand-off
 * happens.
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
