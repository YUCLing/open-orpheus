import os from "node:os";
import { resolve } from "node:path";

import {
  app,
  Menu,
  MenuItemConstructorOptions,
  nativeImage,
  NativeImage,
  Tray,
} from "electron";

import showManageWindow from "./windows/manage";

import iconFilename from "../../assets/icon_256.png?no-inline";
import type { SettingsService, WindowService } from "./bootstrap/types";

const defaultIconPath = resolve(import.meta.dirname, `.${iconFilename}`);

export interface TrayService {
  install(): void;
  uninstall(): void;
  setIcon(icon: NativeImage): void;
  setTooltip(tooltip: string): void;
  isInstalled(): boolean;
}

export interface TrayDeps {
  windows: Pick<WindowService, "currentWindow">;
  settings: Pick<SettingsService, "kv" | "events">;
}

function createIconForDarwin(icon: NativeImage) {
  if (os.platform() !== "darwin") return icon;
  // On macOS, we need to generate a set of icons with different sizes
  const image = nativeImage.createEmpty();

  const sizes = [16, 32, 64];

  for (let i = 0; i < sizes.length; i++) {
    const size = sizes[i];
    image.addRepresentation({
      scaleFactor: i + 1,
      width: size,
      height: size,
      buffer: icon.resize({ width: size, height: size }).toPNG(),
    });
  }

  return image;
}

export function createTray(deps: TrayDeps): TrayService {
  let quitRequested = false;
  let trayInstalled = false;
  let icon: NativeImage | null = null;
  let tooltip: string | null = null;

  const buildDefaultMenuItems = (): MenuItemConstructorOptions[] => [
    {
      label: "管理 Open Orpheus",
      click: () => {
        showManageWindow({ settings: deps.settings });
      },
    },
    {
      label: "退出",
      click: () => {
        const mainWindow = deps.windows.currentWindow();
        if (
          trayInstalled &&
          !quitRequested &&
          mainWindow &&
          !mainWindow.isDestroyed()
        ) {
          // NCM seems to be ready, and is not , we will go with graceful way as of now
          mainWindow.webContents.send(
            "channel.call",
            "winhelper.onmenuclick",
            "exitApp",
            0
          );
          quitRequested = true;
          return;
        }
        app.quit();
      },
    },
  ];

  const defaultIcon = createIconForDarwin(
    nativeImage.createFromPath(defaultIconPath)
  );

  const trayIcon = new Tray(defaultIcon);

  trayIcon.setToolTip("Open Orpheus 启动中");
  trayIcon.setContextMenu(Menu.buildFromTemplate(buildDefaultMenuItems()));

  function setIcon(newIcon: NativeImage) {
    newIcon = createIconForDarwin(newIcon);
    icon = newIcon;
    if (trayInstalled) {
      trayIcon.setImage(newIcon);
    }
  }

  function setTooltip(newTooltip: string) {
    tooltip = newTooltip;
    if (trayInstalled) {
      trayIcon.setToolTip(newTooltip);
    }
  }

  async function clickHandler() {
    const mainWindow = deps.windows.currentWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // Linux can only receives click, so a different behavior is used
    // The `onclick` will be send when main window is invisible, and `onrightclick` will be send when main window is visible
    const clickBehavior = await deps.settings.kv.get("tray.clickBehavior");
    mainWindow.webContents.send(
      "channel.call",
      // We only send rightclick here if is Linux, the main window is visible, and the user has not set the click behavior to "always-show-main-window",
      // or, on Linux, if the user has set the click behavior to "always-show-menu", in which case we always send rightclick to show the menu
      os.platform() !== "linux" ||
        (clickBehavior !== "always-show-menu" && !mainWindow.isVisible()) ||
        clickBehavior === "always-show-main-window"
        ? "trayicon.onclick"
        : "trayicon.onrightclick"
    );
  }

  function rightClickHandler() {
    const mainWindow = deps.windows.currentWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("channel.call", "trayicon.onrightclick");
  }

  function install() {
    if (trayInstalled) {
      throw new Error("NCM already installed the tray icon");
    }
    if (!icon) {
      throw new Error("Tray icon not initialized");
    }
    trayIcon.setImage(icon);
    if (tooltip) {
      trayIcon.setToolTip(tooltip);
    } else {
      trayIcon.setToolTip("");
    }
    trayIcon.on("click", clickHandler);
    trayIcon.on("right-click", rightClickHandler);
    if (os.platform() === "linux") {
      trayIcon.setContextMenu(
        Menu.buildFromTemplate([
          {
            label: "显示网易云音乐菜单",
            click: () => {
              // Although it can't be non-existing...
              const mainWindow = deps.windows.currentWindow();
              if (!mainWindow || mainWindow.isDestroyed()) return;
              mainWindow.webContents.send(
                "channel.call",
                "trayicon.onrightclick"
              );
            },
          },
          {
            type: "separator",
          },
          ...buildDefaultMenuItems(),
        ])
      );
    } else {
      trayIcon.setContextMenu(null);
    }
    trayInstalled = true;
  }

  function uninstall() {
    if (!trayInstalled) {
      throw new Error("Tray icon not installed");
    }
    trayIcon.setToolTip("");
    trayIcon.off("click", clickHandler);
    trayIcon.off("right-click", rightClickHandler);
    trayIcon.setImage(defaultIcon);
    trayIcon.setContextMenu(Menu.buildFromTemplate(buildDefaultMenuItems()));
    trayInstalled = false;
  }

  return {
    install,
    uninstall,
    setIcon,
    setTooltip,
    isInstalled: () => trayInstalled,
  };
}
