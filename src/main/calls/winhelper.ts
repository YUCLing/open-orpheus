import { BrowserWindow, nativeImage } from "electron";
import path from "node:path";
import os from "node:os";

import { dragWindow } from "window";

import { registerCallHandler } from "../calls";
import { loadFromOrpheusUrl } from "../orpheus";
import { getWindowScaleFactor, pngFromIco } from "../util";
import { addWindow, setMaximumSize } from "../window";

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
    // TODO: Confirm macOS desired behavior, Windows and Linux (Wayland) is already tested to be correct
    const scaleFactor =
      os.platform() === "win32" ? getWindowScaleFactor(wnd) : 1;
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
    const scaleFactor =
      os.platform() === "win32" ? getWindowScaleFactor(wnd) : 1;
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

// TODO: Support menu
registerCallHandler<
  [
    {
      content: string;
      hotkey: string;
      left_border_size: number;
      menu_type: "normal";
    },
    number,
  ],
  void
>("winhelper.updateMenu", () => {
  return;
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
