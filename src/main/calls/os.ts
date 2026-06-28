import { isAbsolute } from "node:path";
import os from "node:os";
import { statfs } from "node:fs/promises";

import { BrowserWindow, powerSaveBlocker, screen, shell } from "electron";

import { getSystemFonts } from "@open-orpheus/ui";

import { fileExists, normalizePath, sanitizeRelativePath } from "../util";
import { registerCallHandler } from "../calls";
import { getADDeviceId, getDeviceId } from "../device";

registerCallHandler<[string], [boolean]>(
  "os.isFileExist",
  async (event, path) => {
    const filePath = isAbsolute(path)
      ? path
      : sanitizeRelativePath("data", path);
    if (filePath === false) return [false];
    return [await fileExists(normalizePath(filePath))];
  }
);

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
          width: scr.workAreaSize.width, // TODO: Confirm if we need to apply scale factor
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
  (event, ...fonts) => {
    const systemFonts = getSystemFonts();
    return ["success", fonts.filter((font) => systemFonts.includes(font))];
  }
);

registerCallHandler<[], [string, string[]]>("os.querySystemFonts", () => {
  return ["success", getSystemFonts()];
});

registerCallHandler<[string], void>("os.navigateExternal", (event, url) => {
  shell.openExternal(url);
});

registerCallHandler<[string], void>("os.shellOpen", (event, path) => {
  shell.openPath(normalizePath(path));
});

registerCallHandler<[string], void>("os.shellExplor", (event, path) => {
  shell.showItemInFolder(normalizePath(path));
});

let preventSystemSleepBlocker: null | number = null,
  preventDisplaySleepBlocker: null | number = null;
registerCallHandler<
  [
    {
      enable: boolean;
      preventSystemSleep: boolean;
      preventDisplaySleep: boolean;
    },
  ],
  void
>(
  "os.setPowerRequests",
  (event, { enable, preventSystemSleep, preventDisplaySleep }) => {
    if (enable) {
      if (preventSystemSleep) {
        if (!preventSystemSleepBlocker) {
          preventSystemSleepBlocker = powerSaveBlocker.start(
            "prevent-app-suspension"
          );
        }
      } else {
        if (preventSystemSleepBlocker) {
          powerSaveBlocker.stop(preventSystemSleepBlocker);
          preventSystemSleepBlocker = null;
        }
      }
      if (preventDisplaySleep) {
        if (!preventDisplaySleepBlocker) {
          preventDisplaySleepBlocker = powerSaveBlocker.start(
            "prevent-display-sleep"
          );
        }
      } else {
        if (preventDisplaySleepBlocker) {
          powerSaveBlocker.stop(preventDisplaySleepBlocker);
          preventDisplaySleepBlocker = null;
        }
      }
    } else {
      if (preventSystemSleepBlocker) {
        powerSaveBlocker.stop(preventSystemSleepBlocker);
        preventSystemSleepBlocker = null;
      }
      if (preventDisplaySleepBlocker) {
        powerSaveBlocker.stop(preventDisplaySleepBlocker);
        preventDisplaySleepBlocker = null;
      }
    }
  }
);

registerCallHandler<[string], [string]>(
  "os.getDiskSpace",
  async (event, path) => {
    const statResult = await statfs(path);
    return [
      JSON.stringify({
        total: statResult.blocks * statResult.bsize,
        free: statResult.bfree * statResult.bsize,
      }),
    ];
  }
);
