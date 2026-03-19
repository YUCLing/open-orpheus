import { BrowserWindow, Menu, nativeImage } from "electron";
import path from "node:path";
import os from "node:os";

import { dragWindow, isWayland } from "@open-orpheus/window";
import { Menu as NativeMenu } from "@open-orpheus/ui";

import { registerCallHandler } from "../calls";
import { loadFromOrpheusUrl } from "../orpheus";
import { getWindowScaleFactor, pngFromIco } from "../util";
import { getMenus, setMaximumSize } from "../window";
import { AppMenu, AppMenuItem, appMenuItemToMenuItem } from "../menu";
import { getApp } from "../ui";

function shouldApplyScaleFactor() {
  // TODO: Confirm macOS desired behavior, Windows and Linux is already tested to be correct
  return (
    os.platform() === "win32" || (os.platform() === "linux" && !isWayland())
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
  void
>("winhelper.showWindow", (event, show) => {
  const wnd = BrowserWindow.fromWebContents(event.sender);
  if (!wnd) return;

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
    const buf = await pngFromIco(icon.content);
    const image = nativeImage.createFromBuffer(Buffer.from(buf));
    wnd.setIcon(image);
  }
);

registerCallHandler<[], void>("winhelper.initMainWindow", () => {
  return;
});
registerCallHandler<[], void>("winhelper.finishLoadMainWindow", () => {
  return;
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

registerCallHandler<[{ x: number; y: number }, { x: number; y: number }], void>(
  "winhelper.setWindowSizeLimit",
  (event, min, max) => {
    const wnd = BrowserWindow.fromWebContents(event.sender);
    if (!wnd) return;
    wnd.setMinimumSize(min.x, min.y);
    const scaleFactor = shouldApplyScaleFactor()
      ? getWindowScaleFactor(wnd)
      : 1;
    // Use window module to set maximum size to avoid issues with maximized windows
    setMaximumSize(wnd, max.x * scaleFactor, max.y * scaleFactor);
  }
);

registerCallHandler<[], void>("winhelper.bringWindowToTop", (event) => {
  const wnd = BrowserWindow.fromWebContents(event.sender);
  if (!wnd) return;
  wnd.show();
  wnd.focus();
});

registerCallHandler<[unknown, unknown, unknown], void>(
  "winhelper.setNativeWindowShow",
  () => {
    return;
  }
);

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

registerCallHandler<[string, number[], boolean, { id: string }], void>(
  "winhelper.registerHotkey",
  (event, name, keys, isGlobal, extra) => {
    console.warn(
      "winhelper.registerHotkey is not implemented yet, returning dummy results."
    );
    // 1409: being used
    // 0: success
    event.sender.send(
      "channel.call",
      "winhelper.onRegisterHotkeyResult",
      name,
      isGlobal,
      isGlobal ? 1409 : 0,
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
    for (const item of menuItems) {
      if (os.platform() === "linux" && isWayland()) {
        // TODO: why `mine.svg` for `openVinylPage` update?
        (menu as unknown as NativeMenu).updateItem(item);
        continue;
      }
      for (const oldItem of menu) {
        if (item.menu_id === oldItem.menu_id) {
          Object.assign(oldItem, item);
          break;
        }
      }
    }
    // TODO: Update the menu on the fly
  }
);

function parseMenuData(menuData: MenuRequest[0]) {
  return {
    ...menuData,
    content: JSON.parse(menuData.content),
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
    if (os.platform() === "linux" && isWayland()) {
      const menu = new NativeMenu(getApp(), parseMenuData(data));
      menus.set(id, menu as unknown as AppMenu); // Only Wayland is using NativeMenu, so this cast is safe
      menu.onClick((itemId) => {
        event.sender.send("channel.call", "winhelper.onmenuclick", itemId, id);
      });
      menu.show();
    } else {
      const items = JSON.parse(data.content);
      menus.set(id, items);
      const nativeMenu = new Menu();
      for (const item of items) {
        nativeMenu.append(await appMenuItemToMenuItem(event.sender, item, id));
      }
      nativeMenu.popup({ window: wnd });
    }
  }
);
