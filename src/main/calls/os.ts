import { existsSync } from "node:fs";
import os from "node:os";

import { BrowserWindow, screen } from "electron";
import { getFonts } from "font-list";

import { sanitizeRelativePath } from "../util";
import { registerCallHandler } from "../calls";
import { getADDeviceId, getDeviceId } from "../device";

registerCallHandler<[string], [boolean]>("os.isFileExist", (event, path) => {
  const filePath = sanitizeRelativePath("data", path);
  if (filePath === false) return [false];
  return [existsSync(filePath)];
});

registerCallHandler<[], [string]>("os.getDeviceId", () => {
  return [getDeviceId()];
});

registerCallHandler<[], [string]>("os.getADDeviceID", () => {
  return [getADDeviceId()];
});

registerCallHandler<[], void>("os.getDeviceInfo", (event) => {
  const mainWindow = BrowserWindow.fromWebContents(event.sender);
  if (!mainWindow) return;

  event.sender.send("channel.call", "os.onGetDeviceInfo", {
    app_platform: process.arch === "x64" ? "64" : "32",
    computername: os.hostname(),
    cpu: os.cpus()[0].model,
    cpu_cores: os.availableParallelism(), // TODO: physical cores
    cpu_cores_logic: os.availableParallelism(),
    ram: os.totalmem() + " bytes",
    model: "System Product Name", // TODO: find a way to get this
    devicename: os.userInfo().username,
  });
});

registerCallHandler<[string], [unknown]>("os.getSystemInfo", (event_, kind) => {
  // TODO: Implement this properly
  if (kind === "monitor") {
    const mainWindow = BrowserWindow.fromWebContents(event_.sender);
    if (!mainWindow) return [undefined];
    const scr = screen.getDisplayMatching(mainWindow.getBounds());
    return [
      {
        factor: scr.scaleFactor,
        monitor: {
          width: scr.size.width,
          height: scr.size.height,
          x: scr.bounds.x,
          y: scr.bounds.y,
        },
        monitorName: scr.label,
        workArea: {
          width: scr.workAreaSize.width,
          height: scr.workAreaSize.height,
          x: scr.workArea.x,
          y: scr.workArea.y,
        },
      },
    ];
  }
  return [undefined];
});

registerCallHandler<string[], [string, string[]]>(
  "os.checkNativeSupportFonts",
  async (event, ...fonts) => {
    const systemFonts = await getFonts();
    return ["success", fonts.filter((font) => systemFonts.includes(font))];
  }
);

registerCallHandler<[], [string, string[]]>("os.querySystemFonts", async () => {
  return ["success", await getFonts()];
});
