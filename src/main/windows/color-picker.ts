import { join } from "node:path";

import { BrowserWindow } from "electron";

import { ManagedWindow } from "@main/window";
import { registerIpcHandlers } from "@main/bridge/register";
import { Color, ColorPickerContract } from "@shared/contracts/color-picker-api";

class ColorPickerWindow extends ManagedWindow {
  constructor(
    callback: (value: Color | null) => void,
    initial?: `#${string}`,
    parent?: BrowserWindow
  ) {
    super();
    const wnd = this.createBrowserWindow({
      title: "选择颜色",
      width: 300 + 16 * 2,
      minWidth: 300 + 16 * 2,
      height: 500,
      resizable: false,
      parent,
      webPreferences: {
        partition: "open-orpheus",
        preload: join(import.meta.dirname, "color-picker.cjs"),
      },
    });
    let finished = false;
    registerIpcHandlers<ColorPickerContract>(wnd.webContents, "picker", {
      initialValue: async () => initial ?? "#ffffff",
      save: async (event, value) => {
        if (finished) return;
        callback(value);
        finished = true;
        wnd.close();
      },
    });
    wnd.on("closed", () => {
      if (finished) return;
      callback(null);
      finished = true;
    });
    this.loadGuiRoute("/color-picker");
  }
}

export default async function pickColor(initial?: `#${string}`, parent?: BrowserWindow) {
  return await new Promise<Color | null>((resolve) => {
    void new ColorPickerWindow(resolve, initial, parent).show();
  });
}
