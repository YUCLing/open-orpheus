import { BrowserWindow, nativeImage } from "electron";
import { registerCallHandler } from "../calls";
import { loadFromOrpheusUrl } from "../orpheus";
import { pngFromIco } from "../util";

// TODO: Implement this properly
registerCallHandler<[], [boolean]>("winhelper.isWindowFullScreen", () => [
  false,
]);

registerCallHandler<[string], void>(
  "winhelper.setWindowTitle",
  (event, title) => {
    BrowserWindow.fromWebContents(event.sender)?.setTitle(title);
  }
);

registerCallHandler<[string], void>(
  "winhelper.setWindowIconFromLocalFile",
  async (event, iconPath) => {
    const mainWindow = BrowserWindow.fromWebContents(event.sender);
    if (!mainWindow) return;

    const icon = await loadFromOrpheusUrl(iconPath);
    const buf = await pngFromIco(icon.content);
    const image = nativeImage.createFromBuffer(Buffer.from(buf));
    mainWindow.setIcon(image);
  }
);

registerCallHandler<[], void>("winhelper.initMainWindow", () => {
  return;
});
registerCallHandler<[], void>("winhelper.finishLoadMainWindow", (event) => {
  const mainWindow = BrowserWindow.fromWebContents(event.sender);
  if (!mainWindow) return;
  mainWindow.show();
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
    const mainWindow = BrowserWindow.fromWebContents(event.sender);
    if (!mainWindow) return;
    mainWindow.setBounds({ width, height, x, y });
    mainWindow.setAlwaysOnTop(topmost);
  }
);

registerCallHandler<[], [WindowPosition]>(
  "winhelper.getWindowPosition",
  (event) => {
    const mainWindow = BrowserWindow.fromWebContents(event.sender);
    if (!mainWindow)
      return [{ width: 0, height: 0, x: 0, y: 0, topmost: false }];

    const bounds = mainWindow.getBounds();
    const topmost = mainWindow.isAlwaysOnTop();
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
  () => {
    // params[0] as { x: number, y: number }
    // params[1] as { x: number, y: number }
    // size limit??
  }
);

registerCallHandler<[], void>("winhelper.bringWindowToTop", (event) => {
  const mainWindow = BrowserWindow.fromWebContents(event.sender);
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
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
      //show: attributes.visible,
      skipTaskbar: !attributes.taskbarButton,
      backgroundColor: attributes.bk_color,
    });
    wnd.loadURL(url);
    return [true];
  }
);
