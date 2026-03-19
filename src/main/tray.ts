import { Menu, NativeImage, Tray } from "electron";
import os from "node:os";

let icon: NativeImage | null = null;
let tooltip: string | null = null;
let menu: Menu | null = null;

let trayIcon: Tray | null = null;

let mainWnd: Electron.BrowserWindow | null = null;

export function get(): Tray | null {
  return trayIcon;
}

export function bindMainWindow(mainWindow: Electron.BrowserWindow) {
  mainWnd = mainWindow;
}

export function setIcon(newIcon: NativeImage) {
  icon = newIcon;
  if (trayIcon) {
    trayIcon.setImage(newIcon);
  }
}

export function setTooltip(newTooltip: string) {
  tooltip = newTooltip;
  if (trayIcon) {
    trayIcon.setToolTip(newTooltip);
  }
}

export function setMenu(newMenu: Menu) {
  menu = newMenu;
  if (trayIcon) {
    trayIcon.setContextMenu(newMenu);
  }
}

export function install() {
  if (trayIcon) {
    throw new Error("Tray icon already installed");
  }
  if (!icon) {
    throw new Error("Tray icon not initialized");
  }
  trayIcon = new Tray(icon);
  if (tooltip) {
    trayIcon.setToolTip(tooltip);
  }
  if (menu) {
    trayIcon.setContextMenu(menu);
  }
  trayIcon.on("click", () => {
    if (!mainWnd) return;
    // Linux can only receives click, so a different behavior is used
    // The `onclick` will be send when main window is invisible, and `onrightclick` will be send when main window is visible
    mainWnd.webContents.send(
      "channel.call",
      os.platform() !== "linux" || !mainWnd.isVisible()
        ? "trayicon.onclick"
        : "trayicon.onrightclick"
    );
  });
  trayIcon.on("right-click", () => {
    if (!mainWnd) return;
    mainWnd.webContents.send("channel.call", "trayicon.onrightclick");
  });
}

export function uninstall() {
  if (!trayIcon) {
    throw new Error("Tray icon not installed");
  }
  trayIcon.destroy();
  trayIcon = null;
}
