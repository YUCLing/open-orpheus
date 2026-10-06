import { isAbsolute } from "node:path";
import os from "node:os";
import { statfs } from "node:fs/promises";

import { app, BrowserWindow, Notification, powerSaveBlocker, screen, shell } from "electron";

import { getSystemFonts } from "@open-orpheus/ui";

import { fileExists, normalizePath, sanitizeRelativePath } from "../../platform/util";
import { registerCallHandler } from "../dispatcher";
import type { LifecycleService } from "../../services/lifecycle";
import { getADDeviceId, getDeviceId } from "../../platform/device";
import {
  hasManagedScheduledShutdown,
  keepScheduledShutdownOnExit,
  registerShutdownWork,
  ScheduleShutdownStatus,
  setPowerOffFailureHandler,
  setScheduledShutdown,
} from "../../bootstrap/shutdown";

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

async function disableScheduledShutdown() {
  // Nothing was scheduled by this app, so there is nothing to cancel — and
  // nothing to warn the user about on platforms without the feature.
  if (!hasManagedScheduledShutdown()) return;
  const result = await setScheduledShutdown();
  if (result !== ScheduleShutdownStatus.Ok && result !== ScheduleShutdownStatus.AlreadySet) {
    let body: string;
    switch (result) {
      case ScheduleShutdownStatus.ManagedExternally:
        body = "定时关机已被其他应用设置，如有需要，请手动取消定时关机";
        break;
      default:
        body = "无法取消定时关机，可能是其他应用重新设置了定时关机，请手动取消定时关机";
        break;
    }
    new Notification({
      title: "Open Orpheus",
      body,
    }).show();
  }
}

interface AutoExitState {
  targetTimestamp: number;
  timeout: NodeJS.Timeout;
  shouldShutdown: boolean;
}
let autoExitState: AutoExitState | null = null;

function clearAutoExit() {
  if (!autoExitState) return;
  clearTimeout(autoExitState.timeout);
  autoExitState = null;
}

async function applyExitWindowSystem(seconds: number, shouldShutdown: boolean) {
  clearAutoExit();
  if (isNaN(seconds) || !isFinite(seconds) || seconds <= 0) {
    // Disable auto exit
    await disableScheduledShutdown();
    return;
  }
  const ms = seconds * 1000;
  const targetTimestamp = Date.now() + ms;
  if (shouldShutdown) {
    const result = await setScheduledShutdown(new Date(targetTimestamp));
    if (result !== ScheduleShutdownStatus.Ok && result !== ScheduleShutdownStatus.AlreadySet) {
      // Failed to schedule a shutdown
      let body: string;
      switch (result) {
        case ScheduleShutdownStatus.ManagedExternally:
          body = "定时关机已被其他应用设置，Open Orpheus 将不会修改定时关机设置";
          break;
        default:
          body = "无法设置计划关机，定时关机将不会生效";
          break;
      }
      new Notification({
        title: "Open Orpheus",
        body,
      }).show();
    }
  } else {
    await disableScheduledShutdown();
  }
  const timeout = setTimeout(() => {
    autoExitState = null;
    // Only a countdown that is meant to shut the machine down may keep the
    // system schedule. An app-only countdown must stay cancellable, so an
    // earlier cancel that failed is retried by the exit cleanup instead of the
    // machine powering off at the old time.
    if (shouldShutdown) keepScheduledShutdownOnExit();
    app.quit();
  }, ms);
  autoExitState = {
    targetTimestamp,
    timeout,
    shouldShutdown,
  };
}

// Requests are processed in the order they arrive. Without this, a set whose
// D-Bus round trip is slow can finish after a later cancel and both re-register
// the system shutdown and recreate the in-app timer the user just cancelled.
let exitWindowSystemRequest: Promise<void> = Promise.resolve();

export type OsDeps = {
  lifecycle: Pick<LifecycleService, "registerShutdownTask" | "registerShutdownFinalizer">;
};

export function register(deps: OsDeps): void {
  // This module's shutdown work is registered on the way in rather than as an
  // import side effect, which is what lets a test supply the hooks.
  registerShutdownWork(deps.lifecycle);
  // The auto-exit countdown's last act is a power-off (Windows) that the system can
  // still refuse at the deadline, and the user has to learn that the machine is
  // staying on. It is reported here because this is the layer that can say so in
  // words; the request itself is made while the app is already quitting.
  setPowerOffFailureHandler(() => {
    new Notification({
      title: "Open Orpheus",
      body: "定时关机失败，电脑将不会自动关机，请手动关机",
    }).show();
  });

  registerCallHandler<[string], [boolean]>("os.isFileExist", async (event, path) => {
    const filePath = isAbsolute(path) ? normalizePath(path) : sanitizeRelativePath("data", path);
    if (filePath === false) return [false];
    return [await fileExists(filePath)];
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
    void shell.openExternal(url);
  });

  registerCallHandler<[string], void>("os.shellOpen", (event, path) => {
    void shell.openPath(normalizePath(path));
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
  >("os.setPowerRequests", (event, { enable, preventSystemSleep, preventDisplaySleep }) => {
    if (enable) {
      setPowerRequest("prevent-app-suspension", preventSystemSleep);
      setPowerRequest("prevent-display-sleep", preventDisplaySleep);
    } else {
      setPowerRequest("prevent-app-suspension", false);
      setPowerRequest("prevent-display-sleep", false);
    }
  });

  registerCallHandler<[number, boolean], void>(
    "os.exitWindowSystem",
    (event, seconds, shouldShutdown) => {
      const run = () => applyExitWindowSystem(seconds, shouldShutdown);
      const result = exitWindowSystemRequest.then(run, run);
      exitWindowSystemRequest = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    }
  );

  registerCallHandler<[], [number, number]>("os.exitWindowSystemLeftTime", () => {
    if (!autoExitState) return [-1, 0];
    return [
      Math.max(0, autoExitState.targetTimestamp - Date.now()),
      autoExitState.shouldShutdown ? 1 : 0,
    ];
  });

  registerCallHandler<[string], [string]>("os.getDiskSpace", async (event, path) => {
    const statResult = await statfs(path);
    return [
      JSON.stringify({
        total: statResult.blocks * statResult.bsize,
        free: statResult.bfree * statResult.bsize,
      }),
    ];
  });
}
