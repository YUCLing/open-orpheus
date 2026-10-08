import { join } from "node:path";

import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";

import { ManagedWindow } from "../window";
import { workaroundEnabled, WorkaroundFlags } from "./workaround";

let menuWindow: MenuWindow | null = null;
let overlayWindow: OverlayWindow | null = null;

const menuWindowOptions = {
  title: "Open Orpheus Menu",
  width: 300,
  height: 400,
  show: false,
  frame: false,
  transparent: true,
  hasShadow: true,
  skipTaskbar: true,
  resizable: false,
  alwaysOnTop: true,
  focusable: true,
  webPreferences: {
    partition: "open-orpheus",
    preload: join(import.meta.dirname, "menu.cjs"),
  },
} satisfies BrowserWindowConstructorOptions;

const overlayWindowOptions = {
  title: "Open Orpheus Menu",
  x: 0,
  y: 0,
  frame: false,
  transparent: true,
  hasShadow: false,
  skipTaskbar: true,
  resizable: true,
  alwaysOnTop: true,
  focusable: true,
  webPreferences: {
    partition: "open-orpheus",
    preload: join(import.meta.dirname, "menu.cjs"),
    additionalArguments: ["--wayland"],
  },
} satisfies BrowserWindowConstructorOptions;

function unwrap(managed: ManagedWindow): BrowserWindow {
  const wnd = managed.window;
  if (!wnd) throw new Error("managed window was not created");
  return wnd;
}

class MenuWindow extends ManagedWindow {
  constructor(width = menuWindowOptions.width, height = menuWindowOptions.height) {
    super();
    this.createBrowserWindow({ ...menuWindowOptions, width, height });
    this.loadGuiRoute("/menu");
  }
}

class OverlayWindow extends ManagedWindow {
  constructor() {
    super();
    const wnd = this.createBrowserWindow({
      ...overlayWindowOptions,
      fullscreen: !workaroundEnabled(WorkaroundFlags.OverlayNoFullscreen),
    });
    this.loadGuiRoute("/menu");

    // A maximized window can still provides a great coverage of the screen, but is not able to cover
    // the taskbar, so cursor capturing is not reliable in DEs with this enabled.
    if (
      workaroundEnabled(WorkaroundFlags.OverlayNoFullscreen) &&
      !workaroundEnabled(WorkaroundFlags.OverlayNoMaximize)
    ) {
      wnd.once("show", () => {
        if (!wnd.isDestroyed()) wnd.maximize();
      });
    }
  }
}

const submenuWindowOptions = {
  title: "Open Orpheus Menu",
  show: false,
  frame: false,
  transparent: true,
  backgroundColor: "#00000000",
  hasShadow: true,
  skipTaskbar: true,
  resizable: false,
  alwaysOnTop: true,
  focusable: true,
  webPreferences: {
    partition: "open-orpheus",
    preload: join(import.meta.dirname, "menu.cjs"),
    additionalArguments: ["--submenu"],
  },
} satisfies BrowserWindowConstructorOptions;

/** Popup menu opened next to the main menu. */
class SubmenuWindow extends ManagedWindow {
  constructor(width = menuWindowOptions.width, height = menuWindowOptions.height) {
    super();
    this.createBrowserWindow({ ...submenuWindowOptions, width, height });
    this.loadGuiRoute("/menu");
  }
}

/** A transparent role probe, independent of the active menu's windows. */
class PopupProbeWindow extends ManagedWindow {
  constructor() {
    super();
    this.createBrowserWindow({
      ...menuWindowOptions,
      width: 1,
      height: 1,
      hasShadow: false,
      backgroundColor: "#00000000",
    });
  }
}

export function createPopupProbeWindow(): BrowserWindow {
  return unwrap(new PopupProbeWindow());
}

export function createMenuWindow(
  width = menuWindowOptions.width,
  height = menuWindowOptions.height
): BrowserWindow {
  menuWindow?.window?.destroy();
  menuWindow = new MenuWindow(width, height);
  return unwrap(menuWindow);
}

export function createSubmenuWindow(
  width = menuWindowOptions.width,
  height = menuWindowOptions.height
): BrowserWindow {
  return unwrap(new SubmenuWindow(width, height));
}

export function createOverlayWindow(): BrowserWindow {
  overlayWindow?.window?.destroy();
  overlayWindow = new OverlayWindow();
  return unwrap(overlayWindow);
}

export function destroyMenuWindow() {
  menuWindow?.window?.destroy();
  menuWindow = null;
}

export function destroyOverlayWindow() {
  overlayWindow?.window?.destroy();
  overlayWindow = null;
}

export function getMenuWindow(): BrowserWindow | null {
  const wnd = menuWindow?.window;
  return wnd && !wnd.isDestroyed() ? wnd : null;
}

export function getOverlayWindow(): BrowserWindow | null {
  const wnd = overlayWindow?.window;
  return wnd && !wnd.isDestroyed() ? wnd : null;
}
