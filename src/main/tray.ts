import os from "node:os";

import { Menu, MenuItem, nativeImage, NativeImage, Tray } from "electron";

import { mainWindow } from "./window";
import { kvGet } from "./kv";

export function useGnomeNativeMenu(): boolean {
  return isGnomeDesktop() && kvGet("tray.clickBehavior") === "with-native-menu-gnome";
}
export function useNativeMenu(): boolean {
  return kvGet("tray.clickBehavior") === "with-native-menu";
}

function isGnomeDesktop(): boolean {
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

  // 在 GNOME 兼容模式下，在安装时设置一个占位符上下文菜单。
  // 建立 AppIndicator D-Bus 菜单注册，以便后续的 setContextMenu() 更新能被 GNOME Shell 捕获。
  if (useGnomeNativeMenu() && !menu) {
    console.log("[tray] GNOME: installing placeholder menu!!");
    const placeholder = Menu.buildFromTemplate([
      { label: "加载中...", enabled: false },
    ]);
    trayIcon.setContextMenu(placeholder);
    console.log("[tray] GNOME: set placeholder context menu at install time");

    // 由于设置了上下文菜单，Linux 上的 'click' 事件将不再触发。
    // 在此手动向渲染进程发送一个点击事件，以触发布建真实菜单的逻辑。
    if (mainWindow) {
      console.log("[tray] GNOME: triggering initial menu sync");
      mainWindow.webContents.send("channel.call", "trayicon.onrightclick");
    }
  }
  if (useNativeMenu() && !menu) {
    const nativeMenu = new Menu();
    nativeMenu.append(
      new MenuItem({
        label: "显示菜单",
        click: () => {
          mainWindow?.webContents.send(
            "channel.call",
            "trayicon.onrightclick"
          );
        },
      })
    );
    setMenu(nativeMenu);
  }

  trayIcon.on("click", () => {
    if (!mainWindow) return;
    // Linux can only receives click, so a different behavior is used
    // The `onclick` will be send when main window is invisible, and `onrightclick` will be send when main window is visible
    // We only send rightclick here if is Linux, the main window is visible, and the user has not set the click behavior to "with-native-menu" or "with-native-menu-gnome"
    const eventName =
      os.platform() !== "linux" ||
        (kvGet("tray.clickBehavior") !== "always-show-menu" &&
          !mainWindow.isVisible()) ||
        kvGet("tray.clickBehavior") === "with-native-menu" ||
        kvGet("tray.clickBehavior") === "with-native-menu-gnome"
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
