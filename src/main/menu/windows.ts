import { BrowserWindow } from "electron";
import { join } from "node:path";

let menuWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;

export function createMenuWindow(): BrowserWindow {
  if (menuWindow && !menuWindow.isDestroyed()) {
    menuWindow.destroy();
    menuWindow = null;
  }

  menuWindow = new BrowserWindow({
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
      preload: join(__dirname, "menu.js"),
    },
  });

  if (GUI_VITE_DEV_SERVER_URL) {
    menuWindow.loadURL(`${GUI_VITE_DEV_SERVER_URL}/menu`);
  } else {
    menuWindow.loadURL("gui://frontend/menu");
  }

  menuWindow.on("closed", () => {
    menuWindow = null;
  });

  return menuWindow;
}

export function createOverlayWindow(): BrowserWindow {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.destroy();
    overlayWindow = null;
  }

  overlayWindow = new BrowserWindow({
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
    // Only KDE allows fullscreen transparent windows, see https://gitlab.freedesktop.org/wayland/wayland-protocols/-/issues/116
    fullscreen: process.env.XDG_CURRENT_DESKTOP === "KDE",
    webPreferences: {
      partition: "open-orpheus",
      preload: join(__dirname, "menu.js"),
      additionalArguments: ["--wayland"],
    },
  });

  if (GUI_VITE_DEV_SERVER_URL) {
    overlayWindow.loadURL(`${GUI_VITE_DEV_SERVER_URL}/menu`);
  } else {
    overlayWindow.loadURL("gui://frontend/menu");
  }

  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });

  // For other DEs, we can only use a maximized window, which means we are not able to cover the taskbar,
  // so cursor capturing is not reliable in other DEs.
  if (process.env.XDG_CURRENT_DESKTOP !== "KDE") {
    overlayWindow.once("show", () => {
      overlayWindow?.maximize();
    });
  }

  return overlayWindow;
}

export function destroyMenuWindow() {
  if (menuWindow && !menuWindow.isDestroyed()) {
    menuWindow.destroy();
    menuWindow = null;
  }
}

export function destroyOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.destroy();
    overlayWindow = null;
  }
}

export function getMenuWindow() {
  return menuWindow;
}

export function getOverlayWindow() {
  return overlayWindow;
}
