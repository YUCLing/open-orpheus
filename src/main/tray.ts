import { NativeImage, Tray } from "electron";

let icon: NativeImage | null = null;
let tooltip: string | null = null;

let trayIcon: Tray | null = null;

export function get(): Tray | null {
  return trayIcon;
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
}

export function uninstall() {
  if (!trayIcon) {
    throw new Error("Tray icon not installed");
  }
  trayIcon.destroy();
  trayIcon = null;
}
