import { join } from "node:path";

import { BrowserWindow } from "electron";

import { workaroundEnabled, WorkaroundFlags } from "./workaround";
import { registerWaylandWindowId } from "../registerWaylandWindowId";

let menuWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;

function loadMenuPage(wnd: BrowserWindow, path: string) {
  const load = GUI_VITE_DEV_SERVER_URL
    ? wnd.loadURL(`${GUI_VITE_DEV_SERVER_URL}${path}`)
    : wnd.loadURL(`gui://frontend${path}`);
  void load.catch(() => {
    if (!wnd.isDestroyed()) wnd.destroy();
  });
}

function registerWindowOnWaylandMap(wnd: BrowserWindow) {
  // A show:false BrowserWindow has no xdg surface yet. Registering immediately
  // is still useful for eagerly-created surfaces, while the show hook covers
  // Chromium's lazy Wayland surface creation path.
  registerWaylandWindowId(wnd);
  wnd.on("show", () => registerWaylandWindowId(wnd));
}

export function createMenuWindow(width = 300, height = 400): BrowserWindow {
  if (menuWindow && !menuWindow.isDestroyed()) {
    menuWindow.destroy();
    menuWindow = null;
  }

  const wnd = new BrowserWindow({
    title: "Open Orpheus Menu",
    width,
    height,
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
      preload: join(import.meta.dirname, "menu.js"),
    },
  });
  menuWindow = wnd;
  registerWindowOnWaylandMap(wnd);

  loadMenuPage(wnd, "/menu");

  wnd.on("closed", () => {
    if (menuWindow === wnd) menuWindow = null;
  });

  return wnd;
}

export function createSubmenuWindow(width = 300, height = 400): BrowserWindow {
  const wnd = new BrowserWindow({
    title: "Open Orpheus Menu",
    width,
    height,
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
      preload: join(import.meta.dirname, "menu.js"),
      additionalArguments: ["--submenu"],
    },
  });
  registerWindowOnWaylandMap(wnd);

  loadMenuPage(wnd, "/menu");
  return wnd;
}

export function createOverlayWindow(): BrowserWindow {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.destroy();
    overlayWindow = null;
  }

  const wnd = new BrowserWindow({
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
    fullscreen: !workaroundEnabled(WorkaroundFlags.OverlayNoFullscreen),
    webPreferences: {
      partition: "open-orpheus",
      preload: join(import.meta.dirname, "menu.js"),
      additionalArguments: ["--wayland"],
    },
  });
  overlayWindow = wnd;
  registerWindowOnWaylandMap(wnd);

  loadMenuPage(wnd, "/menu");

  wnd.on("closed", () => {
    if (overlayWindow === wnd) overlayWindow = null;
  });

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

  return wnd;
}

export function destroyMenuWindow() {
  const wnd = menuWindow;
  menuWindow = null;
  if (wnd && !wnd.isDestroyed()) wnd.destroy();
}

export function destroyOverlayWindow() {
  const wnd = overlayWindow;
  overlayWindow = null;
  if (wnd && !wnd.isDestroyed()) wnd.destroy();
}

export function getMenuWindow() {
  return menuWindow;
}

export function getOverlayWindow() {
  return overlayWindow;
}
