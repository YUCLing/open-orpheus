import { join } from "node:path";

import { Display, screen } from "electron";
import {
  DesktopEnvironment,
  getDesktopEnvironment,
  LayerShellLayer,
  LayerShellOptions,
  setWindowAsBackground,
} from "@open-orpheus/window";

import { ManagedWindow } from "../window";
import { isAppUrl } from "../util/url";

export default class MusicDesktopWindow extends ManagedWindow {
  private display: Display | null = null;
  /** The display geometry last applied through `setBounds`. */
  private placed: {
    id: number;
    scaleFactor: number;
    bounds: { x: number; y: number; width: number; height: number };
  } | null = null;
  private layerShellOptions: LayerShellOptions = {
    namespace: "Open Orpheus Music Desktop",
    layer: LayerShellLayer.Background,
    anchorBottom: true,
    anchorLeft: true,
    anchorRight: true,
    anchorTop: true,
    marginBottom: 0,
    marginLeft: 0,
    marginRight: 0,
    marginTop: 0,
    exclusiveZone: -1,
  };

  constructor(url: string) {
    super();
    // A surface's role is decided when the window's first role object is
    // created, which can happen inside `createBrowserWindow`, so the policy has
    // to be registered before the window exists.
    this.setLayerShell(this.layerShellOptions);
    const wnd = this.createBrowserWindow({
      title: "Open Orpheus Music Desktop",
      frame: false,
      resizable: false,
      roundedCorners: false,
      hasShadow: false,
      skipTaskbar: true,
      movable: false,
      transparent: true,
      show: false,
      webPreferences: {
        preload: join(import.meta.dirname, "preload.cjs"),
      },
    });
    if (isAppUrl(url)) {
      void wnd.loadURL(url);
    } else {
      LOGGER.warn({ url }, `refused to load a non-application URL into the music desktop window`);
    }

    const updateBounds = this.updateBounds.bind(this);
    wnd.on("show", updateBounds);
    screen.addListener("display-added", updateBounds);
    screen.addListener("display-metrics-changed", updateBounds);
    screen.addListener("display-removed", updateBounds);
    wnd.addListener("closed", () => {
      screen.removeListener("display-added", updateBounds);
      screen.removeListener("display-metrics-changed", updateBounds);
      screen.removeListener("display-removed", updateBounds);
    });
  }

  private updateBounds() {
    const wnd = this.window;
    const de = getDesktopEnvironment();
    if (
      !wnd ||
      ![DesktopEnvironment.X11, DesktopEnvironment.Windows, DesktopEnvironment.Darwin].includes(de)
    )
      return;

    const isWindows = de === DesktopEnvironment.Windows;
    const display =
      screen.getAllDisplays().find((v) => v.id === this.display?.id) ?? screen.getPrimaryDisplay();

    // Windows keeps the window parented to the WorkerW, where `setBounds` is
    // parent-relative. Give the native side the target in physical pixels
    // instead, so it also follows a display that was removed, re-added or
    // rearranged after attaching.
    let bounds: { x: number; y: number; width: number; height: number } | undefined;
    if (isWindows) {
      const rect = screen.dipToScreenRect(null, display.bounds);
      bounds = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    } else if (this.needsPlacement(display)) {
      // Re-applying identical bounds can resize by a rounding step and restart
      // the page's decoration, so only a real change is applied.
      wnd.setBounds(display.bounds);
      this.placed = {
        id: display.id,
        scaleFactor: display.scaleFactor,
        bounds: { ...display.bounds },
      };
    }

    try {
      setWindowAsBackground(wnd.getNativeWindowHandle(), bounds);
    } catch (e) {
      // Destroy the window and rethrow, deferred so attaching won't crash.
      setImmediate(() => this.destroy());
      throw e;
    }
  }

  /** Whether the window still needs to be moved to `display`'s geometry. */
  private needsPlacement(display: Display): boolean {
    const placed = this.placed;
    return (
      placed === null ||
      placed.id !== display.id ||
      placed.scaleFactor !== display.scaleFactor ||
      placed.bounds.x !== display.bounds.x ||
      placed.bounds.y !== display.bounds.y ||
      placed.bounds.width !== display.bounds.width ||
      placed.bounds.height !== display.bounds.height
    );
  }

  setDisplay(display: Display) {
    LOGGER.info({ id: display.id, label: display.label }, "Setting music desktop display");
    this.display = display;
    this.updateBounds();
    this.layerShellOptions.output = display.id;
    this.setLayerShell(this.layerShellOptions);
  }
}
