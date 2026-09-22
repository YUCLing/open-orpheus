import { isAbsolute } from "node:path";
import os from "node:os";
import { statfs } from "node:fs/promises";

import { app, BrowserWindow, powerSaveBlocker, screen, shell } from "electron";

import { getSystemFonts } from "@open-orpheus/ui";

import {
  fileExists,
  normalizePath,
  sanitizeRelativePath,
} from "../../platform/util";
import { registerCallHandler } from "../dispatcher";
import { getADDeviceId, getDeviceId } from "../../platform/device";

type PowerSaveBlocker = Parameters<typeof powerSaveBlocker.start>[0];
const powerSaveBlockers: Partial<Record<PowerSaveBlocker, number>> = {};
function setPowerRequest(blocker: PowerSaveBlocker, enabled: boolean) {
  if (enabled) {
    if (blocker in powerSaveBlockers) return;
    powerSaveBlockers[blocker] = powerSaveBlocker.start(blocker);
  } else {
    if (!(blocker in powerSaveBlockers)) return;
    const id = powerSaveBlockers[blocker]!;
    if (!powerSaveBlocker.stop(id)) {
      // Failed to stop it, keep it running
      return;
    }
    delete powerSaveBlockers[blocker];
  }
}

interface AutoExitState {
  targetTimestamp: number;
  timeout: NodeJS.Timeout;
  shouldShutdown: boolean;
}
let autoExitState: AutoExitState | null = null;

export function register(): void {
  registerCallHandler<[string], [boolean]>(
    "os.isFileExist",
    async (event, path) => {
      const filePath = isAbsolute(path)
        ? normalizePath(path)
        : sanitizeRelativePath("data", path);
      if (filePath === false) return [false];
      return [await fileExists(filePath)];
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

  registerCallHandler<[string], [unknown]>(
    "os.getSystemInfo",
    (event_, kind) => {
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
    }
  );

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
        setPowerRequest("prevent-app-suspension", preventSystemSleep);
        setPowerRequest("prevent-display-sleep", preventDisplaySleep);
      } else {
        setPowerRequest("prevent-app-suspension", false);
        setPowerRequest("prevent-display-sleep", false);
      }
    }
  );

  registerCallHandler<[number, boolean], void>(
    "os.exitWindowSystem",
    (event, seconds, shouldShutdown) => {
      if (autoExitState) {
        clearTimeout(autoExitState.timeout);
        autoExitState = null;
      }
      if (isNaN(seconds) || !isFinite(seconds) || seconds <= 0) return; // Disable
      const ms = seconds * 1000;
      const timeout = setTimeout(() => {
        autoExitState = null;
        if (shouldShutdown)
          LOGGER.warn("Auto shutdown after exit is currently unsupported.");
        app.quit();
      }, ms);
      autoExitState = {
        targetTimestamp: Date.now() + ms,
        timeout,
        shouldShutdown,
      };
    }
  );

  registerCallHandler<[], [number, number]>(
    "os.exitWindowSystemLeftTime",
    () => {
      if (!autoExitState) return [-1, 0];
      return [
        Math.max(0, autoExitState.targetTimestamp - Date.now()),
        autoExitState.shouldShutdown ? 1 : 0,
      ];
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
}
