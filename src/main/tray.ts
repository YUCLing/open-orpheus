import os from "node:os";

import { Menu, nativeImage, NativeImage, Tray } from "electron";

import { mainWindow } from "./window";
import { kvGet } from "./kv";

export function isGnomeDesktop(): boolean {
  return process.env.XDG_CURRENT_DESKTOP?.toLowerCase().includes("gnome") === true;
}

let icon: NativeImage | null = null;
let tooltip: string | null = null;
let menu: Menu | null = null;

let trayIcon: Tray | null = null;

export function get(): Tray | null {
  return trayIcon;
}

export function setIcon(newIcon: NativeImage) {
  if (os.platform() === "darwin") {
    // On macOS, we need to generate a set of icons with different sizes
    const image = nativeImage.createEmpty();

    const sizes = [16, 32, 64];

    for (let i = 0; i < sizes.length; i++) {
      const size = sizes[i];
      image.addRepresentation({
        scaleFactor: i + 1,
        width: size,
        height: size,
        buffer: newIcon.resize({ width: size, height: size }).toPNG(),
      });
    }

    newIcon = image;
  }
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

export function setMenu(newMenu: Menu | null) {
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

  // 在 GNOME 上，在安装时设置一个占位符上下文菜单。
  // 建立 AppIndicator D-Bus 菜单注册，以便后续的 setContextMenu() 更新能被 GNOME Shell 捕获。
  if (isGnomeDesktop() && !menu) {
    const placeholder = Menu.buildFromTemplate([
      { label: "加载中...", enabled: false },
    ]);
    trayIcon.setContextMenu(placeholder);
    console.log("[tray] GNOME: set placeholder context menu at install time");
  }

  trayIcon.on("click", () => {
    if (!mainWindow) return;
    // Linux can only receives click, so a different behavior is used
    // The `onclick` will be send when main window is invisible, and `onrightclick` will be send when main window is visible
    const eventName =
      os.platform() !== "linux" ||
        (kvGet("tray.clickBehavior") !== "always-show-menu" &&
          !mainWindow.isVisible()) ||
        kvGet("tray.clickBehavior") === "with-native-menu"
        ? "trayicon.onclick"
        : "trayicon.onrightclick";
    mainWindow.webContents.send("channel.call", eventName);
  });
  trayIcon.on("right-click", () => {
    if (!mainWindow) return;
    mainWindow.webContents.send("channel.call", "trayicon.onrightclick");
  });
}

export function uninstall() {
  if (!trayIcon) {
    throw new Error("Tray icon not installed");
  }
  trayIcon.destroy();
  trayIcon = null;
}
