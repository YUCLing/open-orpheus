import { BrowserWindow, Menu, nativeImage } from "electron";
import path from "node:path";
import os from "node:os";

import { dragWindow, isWayland } from "window";

import { registerCallHandler } from "../calls";
import { loadFromOrpheusUrl } from "../orpheus";
import { getWindowScaleFactor, pngFromIco } from "../util";
import { addWindow, setMaximumSize } from "../window";
import { appMenuItemToMenuItem, buildMenu } from "../menu";
import { setMenu } from "../tray";

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
type MenuRequest = (MenuContainer | number)[];

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
    addWindow(wnd);
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

registerCallHandler<MenuRequest, void>(
  "winhelper.updateMenu",
  async (event, ...args) => {
    if (args.length % 2 !== 0) {
      return;
    }
    const menu = new Menu();
    for (let i = 0; i < args.length; i += 2) {
      const data = args[i] as MenuContainer;
      const menuItems = JSON.parse(data.content);
      // TODO: support advanced menu items here.
      for (const item of menuItems) {
        menu.append(
          await appMenuItemToMenuItem(event.sender, item, args[i + 1] as number)
        );
      }
    }
    setMenu(menu);
  }
);

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
  "winhelper.popupMenu",
  async (event, ...args) => {
    if (args.length % 2 !== 0) {
      return;
    }
    for (let i = 0; i < args.length; i += 2) {
      const data = args[i] as MenuContainer;
      const items = JSON.parse(data.content);
      const wnd = BrowserWindow.fromWebContents(event.sender);
      if (!wnd) return;
      const menu = await buildMenu(event.sender, items, args[i + 1] as number);
      menu.popup({ window: wnd });
    }
  }
);
