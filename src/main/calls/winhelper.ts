import { BrowserWindow, clipboard, nativeImage } from "electron";
import path from "node:path";
import os from "node:os";

import type { AppMenuItem } from "$sharedTypes/menu";
import {
  DesktopEnvironment,
  dragWindow,
  getDesktopEnvironment,
} from "@open-orpheus/window";

import { registerCallHandler } from "../calls";
import { loadFromOrpheusUrl } from "../orpheus";
import { getWindowScaleFactor, pngFromIco } from "../util";
import {
  getMenus,
  getWindowById,
  mainWindow,
  setMaximumSize,
  setMinimumSize,
} from "../window";
import AppMenu from "../menu";
import { registerGlobalShortcut, unregisterGlobalShortcut } from "../shortcuts";
import * as settings from "../settings";
import { LifecycleState, setLifecycleState } from "../lifecycle";

function shouldApplyScaleFactor() {
  const de = getDesktopEnvironment();
  return (
    de === DesktopEnvironment.Windows ||
    de === DesktopEnvironment.Darwin ||
    de === DesktopEnvironment.X11
  );
}

type MenuContainer = {
  content: string;
  hotkey: string;
  left_border_size: number;
  menu_type: "normal";
};
type MenuRequest = [MenuContainer, number];

// TODO: Implement this properly
registerCallHandler<[], [boolean]>("winhelper.isWindowFullScreen", () => [
  false,
]);

registerCallHandler<
  ["minimize" | "maximize" | "restore" | "hide" | "show"],
  [boolean]
>("winhelper.showWindow", (event, show) => {
  const wnd = BrowserWindow.fromWebContents(event.sender);
  if (!wnd) return [false];

  switch (show) {
    case "minimize":
      wnd.minimize();
      break;
    case "maximize":
      wnd.maximize();
      break;
    case "restore":
      wnd.restore();
      break;
    case "hide":
      wnd.hide();
      break;
    case "show":
      wnd.show();
      break;
  }

  return [true];
});

registerCallHandler<[string], void>(
  "winhelper.setWindowTitle",
  (event, title) => {
    BrowserWindow.fromWebContents(event.sender)?.setTitle(title);
  }
);

registerCallHandler<[string], void>(
  "winhelper.setWindowIconFromLocalFile",
  async (event, iconPath) => {
    const wnd = BrowserWindow.fromWebContents(event.sender);
    if (!wnd) return;

    const icon = await loadFromOrpheusUrl(iconPath);
    const buf = pngFromIco(icon.content);
    const image = nativeImage.createFromBuffer(Buffer.from(buf));
    wnd.setIcon(image);
  }
);

registerCallHandler<[], void>("winhelper.initMainWindow", () => {
  return;
});
registerCallHandler<[], void>("winhelper.finishLoadMainWindow", (event) => {
  // Window cannot be not existing at this time
  setLifecycleState(
    LifecycleState.MainWindowLoaded,
    BrowserWindow.fromWebContents(event.sender)!
  );
});

type WindowPosition = {
  width: number;
  height: number;
  x: number;
  y: number;
  topmost: boolean;
};
registerCallHandler<[WindowPosition], void>(
  "winhelper.setWindowPosition",
  (event, { width, height, x, y, topmost }) => {
    const wnd = BrowserWindow.fromWebContents(event.sender);
    if (!wnd) return;
    const scaleFactor = shouldApplyScaleFactor()
      ? getWindowScaleFactor(wnd)
      : 1;
    width = Math.round(width / scaleFactor);
    height = Math.round(height / scaleFactor);
    x = Math.round(x / scaleFactor);
    y = Math.round(y / scaleFactor);
    wnd.setBounds({ width, height, x, y });
    wnd.setAlwaysOnTop(topmost);
  }
);

registerCallHandler<[], [WindowPosition]>(
  "winhelper.getWindowPosition",
  (event) => {
    const wnd = BrowserWindow.fromWebContents(event.sender);
    if (!wnd) return [{ width: 0, height: 0, x: 0, y: 0, topmost: false }];

    const bounds = wnd.getBounds();
    const topmost = wnd.isAlwaysOnTop();
    return [
      {
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        topmost,
      },
    ];
  }
);

type SizeLimit = { x: number; y: number };
let mainWindowSizeLimits: [SizeLimit, SizeLimit] | null = null;
registerCallHandler<[{ x: number; y: number }, { x: number; y: number }], void>(
  "winhelper.setWindowSizeLimit",
  async (event, min, max) => {
    const wnd = BrowserWindow.fromWebContents(event.sender);
    if (!wnd) return;
    const scaleFactor = shouldApplyScaleFactor()
      ? getWindowScaleFactor(wnd)
      : 1;
    if (
      wnd !== mainWindow ||
      (await settings.kv.get("window.overrideMainWindowSizeLimit")) !== "true"
    ) {
      // Use window module to set maximum size to avoid issues with maximized/fullscreen windows
      setMinimumSize(wnd, min.x, min.y);
      setMaximumSize(wnd, max.x * scaleFactor, max.y * scaleFactor);
    }
    if (wnd == mainWindow) {
      mainWindowSizeLimits = [
        min,
        { x: max.x * scaleFactor, y: max.y * scaleFactor },
      ];
    }
  }
);
settings.events.on("change", (e) => {
  if (!mainWindow) return;
  const { key, value } = e.data;
  if (key === "window.overrideMainWindowSizeLimit") {
    if (value === "true" || !mainWindowSizeLimits) {
      setMinimumSize(mainWindow, 0, 0);
      setMaximumSize(mainWindow, 0, 0);
    } else {
      setMinimumSize(
        mainWindow,
        mainWindowSizeLimits[0].x,
        mainWindowSizeLimits[0].y
      );
      setMaximumSize(
        mainWindow,
        mainWindowSizeLimits[1].x,
        mainWindowSizeLimits[1].y
      );
    }
  }
});

registerCallHandler<[], void>("winhelper.bringWindowToTop", (event) => {
  const wnd = BrowserWindow.fromWebContents(event.sender);
  if (!wnd) return;
  wnd.show();
  wnd.focus();
});

registerCallHandler<
  [
    string,
    boolean,
    {
      x: number;
      y: number;
      width: number;
      height: number;
    },
  ],
  void
>("winhelper.setNativeWindowShow", (event, id, show /*, workArea*/) => {
  if (!id) return;
  const wnd = getWindowById(id);
  if (!wnd) return;
  if (show) {
    wnd.show();
    wnd.focus();
  } else {
    wnd.hide();
  }
  return;
});

type WindowDimensions = {
  factor: number;
  width: number;
  height: number;
  x: number;
  y: number;
};
type WindowAttributes = {
  bk_color: string;
  corner_size: number;
  resizable: boolean;
  spec_window: boolean;
  taskbarButton: boolean;
  visible: boolean;
};
registerCallHandler<[string, WindowDimensions, WindowAttributes], [boolean]>(
  "winhelper.launchWindow",
  (event, url, dimensions, attributes) => {
    const wnd = new BrowserWindow({
      width: dimensions.width,
      height: dimensions.height,
      resizable: attributes.resizable,
      show: attributes.visible,
      skipTaskbar: !attributes.taskbarButton,
      backgroundColor: attributes.bk_color,
      frame: !attributes.spec_window, // is this correct?
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
      },
    });
    wnd.loadURL(url);
    return [true];
  }
);

registerCallHandler<[], void>("winhelper.dragWindow", (event) => {
  const wnd = BrowserWindow.fromWebContents(event.sender);
  if (!wnd) return;
  const hwnd = wnd.getNativeWindowHandle();
  dragWindow(hwnd);
});

registerCallHandler<[], void>("winhelper.destroyWindow", (event) => {
  const wnd = BrowserWindow.fromWebContents(event.sender);
  if (!wnd) return;
  wnd.close();
});

registerCallHandler<[string, string[], boolean, { id: string }], void>(
  "winhelper.registerHotkey",
  (event, name, keys, isGlobal, extra) => {
    // 1409: being used
    // 0: success
    if (!isGlobal) {
      event.sender.send(
        "channel.call",
        "winhelper.onRegisterHotkeyResult",
        name,
        isGlobal,
        0,
        extra
      );
      return;
    }
    const success = registerGlobalShortcut(name, keys, () => {
      event.sender.send("channel.call", "winhelper.onHotkey", name, isGlobal);
    });
    event.sender.send(
      "channel.call",
      "winhelper.onRegisterHotkeyResult",
      name,
      isGlobal,
      success ? 0 : 1409,
      extra
    );
  }
);

registerCallHandler<[string, string[], boolean, { id: string }], void>(
  "winhelper.unregisterHotkey",
  (event, name, isGlobal, extra) => {
    if (!isGlobal) {
      event.sender.send(
        "channel.call",
        "winhelper.onUnregisterHotkeyResult",
        name,
        isGlobal,
        0,
        extra
      );
      return;
    }
    unregisterGlobalShortcut(name);
    event.sender.send(
      "channel.call",
      "winhelper.onUnregisterHotkeyResult",
      name,
      isGlobal,
      0,
      extra
    );
  }
);

registerCallHandler<[boolean], void>(
  "winhelper.setWindowFullScreen",
  (event, fullscreen) => {
    const wnd = BrowserWindow.fromWebContents(event.sender);
    if (!wnd) return;
    wnd.setFullScreen(fullscreen);
  }
);

registerCallHandler<MenuRequest, void>(
  "winhelper.updateMenu",
  async (event, data, id) => {
    const wnd = BrowserWindow.fromWebContents(event.sender);
    if (!wnd) return;
    id = 0; // TODO: id doesn't seem to be id, what it is?
    const menus = getMenus(wnd);
    const menu = menus.get(id);
    if (!menu) {
      return;
    }
    const menuItems = JSON.parse(data.content) as AppMenuItem[];
    menu.update(menuItems);
  }
);

function parseMenuData(menuData: MenuRequest[0]) {
  return {
    ...menuData,
    content: JSON.parse(menuData.content) as AppMenuItem[],
    hotkey: JSON.parse(menuData.hotkey),
  };
}
registerCallHandler<MenuRequest, void>(
  "winhelper.popupMenu",
  async (event, data, id) => {
    const wnd = BrowserWindow.fromWebContents(event.sender);
    if (!wnd) return;
    id = 0; // TODO: id doesn't seem to be id, what it is?
    const menus = getMenus(wnd);
    const parsedMenuData = parseMenuData(data);
    const injectShowMainWindowMenuItem =
      os.platform() === "linux" &&
      (await settings.kv.get("tray.clickBehavior")) === "always-show-menu";
    for (let i = 0; i < parsedMenuData.content.length; i++) {
      const item = parsedMenuData.content[i];
      // Inject show main window menu item if tray.clickBehavior is "always-show-menu"
      if (injectShowMainWindowMenuItem && item.menu_id === "exitApp") {
        parsedMenuData.content.splice(i, 0, {
          menu: true,
          separator: false,
          enable: true,
          children: null,
          image_color: "#00000000",
          menu_id: "openOrpheus.showMainWindow",
          text: "显示主窗口",
        });
        i++; // Skip the injected menu item
      }
    }
    const onClick = (itemId: string | null) => {
      if (itemId === "openOrpheus.showMainWindow") {
        event.sender.send("channel.call", "trayicon.onclick");
        return;
      }
      event.sender.send("channel.call", "winhelper.onmenuclick", itemId, id);
    };
    const menu = new AppMenu(parsedMenuData.content);
    menus.set(id, menu);
    menu.setClickHandler(onClick);
    menu.show();
  }
);

registerCallHandler<[string], void>(
  "winhelper.setClipBoardData",
  (event, data) => {
    clipboard.writeText(data);
  }
);
