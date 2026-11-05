import { join } from "node:path";

import { BaseWindow, screen, WebContentsView } from "electron";
import { DesktopEnvironment, forgetWindowState, getDesktopEnvironment } from "@open-orpheus/window";

import type { InputRegion } from "@shared/types/input-region";
import type { MenuChildOpenRequest } from "@shared/types/menu-surface";
import { toError } from "@shared/util";

import { SURFACE_READY_TIMEOUT_MS } from "../constants";
import { font } from "../../gui";
import { BaseWindowManagedWindow, guiUrl as makeGuiUrl } from "../../window";
import { sendIfAlive } from "../../util/send";
import type {
  MenuMeasurement,
  MenuSurfaceConfig,
  MenuSurfaceId,
  MenuUpdate,
} from "@shared/types/menu-surface";
import type { MenuSurface } from "./MenuSurface";

const MENU_TITLE = "Open Orpheus Menu";

export interface WindowSurfaceOptions {
  route?: string;
  fullscreen?: boolean;
  maximize?: boolean;
  /** False for the overlay: it renders its own panels and reports no size. */
  measure?: boolean;
}

export interface MenuSurfaceHandlers {
  onItemClick(menuId: string | null): void;
  onButtonClick(btnId: string): void;
  onClose(): void;
  onOpenChild(request: MenuChildOpenRequest): void | Promise<void>;
  onCloseChildren(parentId: MenuSurfaceId): void;
  onBlur?(surfaceId: MenuSurfaceId): void;
  onMeasurement?(surfaceId: MenuSurfaceId, measurement: MenuMeasurement): void;
}

interface PrepareMessage extends MenuSurfaceConfig {
  requestId: number;
}

interface MeasurementMessage {
  requestId: number;
  width: number;
  height: number;
}

interface VisibleMessage {
  requestId: number;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * One BaseWindow + WebContentsView menu surface.
 *
 * The view is created immediately and loaded while warm; the BaseWindow is
 * created only in `present()` after the renderer reports its measured size.
 */
export class BaseWindowMenuSurface implements MenuSurface {
  readonly id: MenuSurfaceId;
  readonly view: WebContentsView;
  private readonly host = new BaseWindowManagedWindow();

  private window: BaseWindow | null = null;
  private pendingInputRegions: InputRegion[] | null = null;
  private measurement: MenuMeasurement | null = null;
  private requestId = 0;
  private prepared = false;
  private presentation: MenuSurfaceConfig | null = null;
  private backgroundColor = "#202020";
  private visibleRequest: ReturnType<typeof deferred<void>> | null = null;
  private measurementRequest: ReturnType<typeof deferred<MenuMeasurement>> | null = null;
  private rendererReady = deferred<void>();
  private closed = false;
  private blurArmed = false;

  private readonly options: Required<WindowSurfaceOptions>;

  constructor(
    private readonly handlers: MenuSurfaceHandlers,
    options: WindowSurfaceOptions = {}
  ) {
    this.id = this.host.id;
    this.options = {
      route: options.route ?? "/menu-surface",
      fullscreen: options.fullscreen ?? false,
      maximize: options.maximize ?? false,
      measure: options.measure ?? true,
    };
    this.view = new WebContentsView({
      webPreferences: {
        preload: join(import.meta.dirname, "menu.cjs"),
        partition: "open-orpheus",
        // Hidden spare views must keep their timers running while warming.
        backgroundThrottling: false,
      },
    });
    // BaseWindow transparency does not extend to child views: the view paints
    // its own background unless this is set too.
    this.view.setBackgroundColor("#00000000");
    this.view.setBounds({ x: 0, y: 0, width: 300, height: 400 });
    this.registerIpc();
    void this.view.webContents.loadURL(makeGuiUrl(this.options.route)).catch((error) => {
      if (this.closed) return;
      LOGGER.error({ err: toError(error), surfaceId: this.id }, "Failed to load menu surface");
      this.measurementRequest?.reject(error);
      this.visibleRequest?.reject(error);
    });
  }

  private registerIpc() {
    const ipc = this.view.webContents.ipc;

    ipc.handle("menu.surface.ready", async () => {
      this.rendererReady.resolve();
      return true;
    });

    ipc.handle("menu.surface.getFont", async () => font);

    ipc.handle("menu.surface.reportSize", async (_event, payload: MeasurementMessage) => {
      if (payload.requestId !== this.requestId) return false;
      if (!Number.isFinite(payload.width) || !Number.isFinite(payload.height)) {
        this.measurementRequest?.reject(new Error("invalid menu measurement"));
        this.measurementRequest = null;
        return false;
      }
      const measurement = {
        width: Math.ceil(payload.width),
        height: Math.ceil(payload.height),
      };
      this.measurement = measurement;
      if (this.measurementRequest) {
        this.measurementRequest.resolve(measurement);
        this.measurementRequest = null;
        return true;
      }
      if (!this.prepared) return false;
      this.applyMeasurement(measurement);
      return true;
    });

    ipc.handle("menu.surface.visible", async (_event, payload: VisibleMessage) => {
      if (payload.requestId !== this.requestId || !this.visibleRequest) return false;
      this.visibleRequest.resolve();
      this.visibleRequest = null;
      return true;
    });

    ipc.handle("menu.surface.itemClick", async (_event, menuId: string | null) => {
      this.handlers.onItemClick(menuId);
    });

    ipc.handle("menu.surface.btnClick", async (_event, btnId: string) => {
      this.handlers.onButtonClick(btnId);
    });

    ipc.handle("menu.surface.close", async () => {
      this.handlers.onClose();
    });

    ipc.handle("menu.surface.openChild", async (_event, request: MenuChildOpenRequest) => {
      await this.handlers.onOpenChild(request);
    });

    ipc.handle("menu.surface.closeChildren", async (_event, parentId: MenuSurfaceId) => {
      this.handlers.onCloseChildren(parentId);
    });

    ipc.handle("inputRegion.setInputRegions", async (_event, regions: InputRegion[]) => {
      if (!this.window || this.window.isDestroyed()) {
        this.pendingInputRegions = regions;
        return true;
      }
      return this.applyInputRegions(regions);
    });
  }

  async prepare(
    config: MenuSurfaceConfig,
    timeoutMs = SURFACE_READY_TIMEOUT_MS
  ): Promise<MenuMeasurement> {
    if (this.closed) throw new Error("surface is closed");
    if (this.presented) throw new Error("cannot prepare a presented surface");

    this.requestId += 1;
    this.presentation = config;
    this.backgroundColor = config.colors.background || "#202020";

    const readyTimeout = Math.max(1, Math.min(timeoutMs, SURFACE_READY_TIMEOUT_MS));
    await withTimeout(this.rendererReady.promise, readyTimeout, "renderer ready");
    if (this.closed) throw new Error("surface closed while preparing");

    const measurement = deferred<MenuMeasurement>();
    this.measurementRequest = measurement;
    const message: PrepareMessage = { ...config, requestId: this.requestId };
    sendIfAlive(this.view.webContents, "menu.surface.prepare", message);

    const result = this.options.measure
      ? await withTimeout(measurement.promise, readyTimeout, "menu measurement")
      : (() => {
          const bounds = screen.getPrimaryDisplay().bounds;
          this.measurementRequest = null;
          const measurement = { width: bounds.width, height: bounds.height };
          this.measurement = measurement;
          return measurement;
        })();
    this.prepared = true;
    return result;
  }

  private applyInputRegions(regions: InputRegion[]): boolean {
    if (!this.window || this.window.isDestroyed()) return false;
    if (
      getDesktopEnvironment() === DesktopEnvironment.Wayland ||
      getDesktopEnvironment() === DesktopEnvironment.X11
    ) {
      return this.host.setWindowInputRegion(regions);
    }
    this.window.setIgnoreMouseEvents(regions.length > 0, { forward: true });
    return true;
  }

  private applyMeasurement(measurement: MenuMeasurement): void {
    const current = this.window;
    if (!current || current.isDestroyed()) return;
    current.setSize(measurement.width, measurement.height);
    this.view.setBounds({ x: 0, y: 0, ...measurement });
    this.handlers.onMeasurement?.(this.id, measurement);
  }

  present(): void {
    if (!this.prepared || !this.measurement) {
      throw new Error("surface must be prepared before present");
    }
    if (this.window) return;

    const { width, height } = this.measurement;
    const opaqueFallback = getDesktopEnvironment() === DesktopEnvironment.X11;
    this.view.setBackgroundColor(opaqueFallback ? this.backgroundColor : "#00000000");
    const window = new BaseWindow({
      show: false,
      frame: false,
      width,
      height,
      fullscreen: this.options.fullscreen,
      transparent: !opaqueFallback,
      backgroundColor: opaqueFallback ? this.backgroundColor : "#00000000",
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: true,
      hasShadow: false,
    });
    this.window = window;
    this.host.attach(window);
    this.host.setTitle(MENU_TITLE);
    if (this.pendingInputRegions) {
      const regions = this.pendingInputRegions;
      this.pendingInputRegions = null;
      this.applyInputRegions(regions);
    }
    window.contentView.addChildView(this.view);
    this.view.setBounds({ x: 0, y: 0, width, height });
    const syncViewBounds = () => {
      const current = this.window;
      if (!current || current.isDestroyed()) return;
      const [contentWidth, contentHeight] = current.getContentSize();
      // X11 may report a zero content size immediately after mapping; the
      // bounds still carry the real geometry.
      const bounds = current.getBounds();
      const width = contentWidth > 0 ? contentWidth : bounds.width;
      const height = contentHeight > 0 ? contentHeight : bounds.height;
      this.view.setBounds({ x: 0, y: 0, width, height });
    };
    window.on("resize", syncViewBounds);
    window.on("closed", () => {
      this.window = null;
      this.visibleRequest?.reject(new Error("menu surface closed before visible"));
      this.visibleRequest = null;
      if (!this.closed) {
        this.closed = true;
        if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
        this.host.releaseNativeState();
        this.handlers.onClose();
      }
    });
    window.on("blur", () => {
      if (!this.closed && this.blurArmed) this.handlers.onBlur?.(this.id);
    });
  }

  sendCursor(position: { x: number; y: number; fallback?: boolean }): void {
    sendIfAlive(this.view.webContents, "menu.surface.cursor", {
      requestId: this.requestId,
      x: position.x,
      y: position.y,
      fallback: position.fallback,
    });
  }

  isFocused(): boolean {
    return this.window?.isFocused() ?? false;
  }

  focus(): void {
    if (this.closed || !this.window) return;
    this.window.focus();
    this.view.webContents.focus();
  }

  getBounds(): { x: number; y: number; width: number; height: number } | null {
    return this.window?.getBounds() ?? null;
  }

  setPosition(x: number, y: number): void {
    this.window?.setPosition(Math.round(x), Math.round(y));
  }

  async show(timeoutMs = SURFACE_READY_TIMEOUT_MS): Promise<void> {
    if (this.closed) throw new Error("surface is closed");
    if (!this.window) this.present();
    if (!this.window) throw new Error("menu window was not created");

    const visible = deferred<void>();
    this.visibleRequest = visible;
    if (this.options.maximize && !this.options.fullscreen) this.window.maximize();
    // Inactive popup surfaces do not reliably receive pointer motion.
    this.window.show();
    this.window.focus();
    const syncViewBounds = () => {
      const current = this.window;
      if (!current || current.isDestroyed()) return;
      const [contentWidth, contentHeight] = current.getContentSize();
      const bounds = current.getBounds();
      const width = contentWidth > 0 ? contentWidth : bounds.width;
      const height = contentHeight > 0 ? contentHeight : bounds.height;
      this.view.setBounds({ x: 0, y: 0, width, height });
    };
    syncViewBounds();
    this.view.webContents.focus();
    sendIfAlive(this.view.webContents, "menu.surface.show", { requestId: this.requestId });

    await withTimeout(
      visible.promise,
      Math.max(1, Math.min(timeoutMs, SURFACE_READY_TIMEOUT_MS)),
      "menu visible"
    );
    // Focus may not apply until the surface is mapped.
    if (!this.closed && this.window) {
      this.window.focus();
      this.view.webContents.focus();
      this.blurArmed = true;
    }
  }

  update(update: MenuUpdate): void {
    if (this.closed) return;
    sendIfAlive(this.view.webContents, "menu.surface.update", update);
    if (update.items) {
      this.presentation = this.presentation ? { ...this.presentation, items: update.items } : null;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.measurementRequest?.reject(new Error("surface closed"));
    this.measurementRequest = null;
    this.visibleRequest?.reject(new Error("surface closed"));
    this.visibleRequest = null;

    const window = this.window;
    this.window = null;
    if (window && !window.isDestroyed()) this.host.destroy();
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.host.releaseNativeState();
    forgetWindowState(this.id);
  }

  private get presented(): boolean {
    return this.window !== null;
  }
}
