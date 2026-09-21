import { existsSync } from "node:fs";

import { app, Menu, protocol } from "electron";

import started from "electron-squirrel-startup";

import {
  disableHardwareAccelerationFlag,
  userdata as userdataDir,
} from "@main/folders";
import { checkEnvFlagPresent } from "@main/util";

export function configureProcess() {
  // Handle creating/removing shortcuts on Windows when installing/uninstalling.
  if (started) {
    app.quit();
  }

  // Enforce single instance
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  }

  // Register privileged schemes
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "orpheus",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
    {
      scheme: "gui",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
    {
      scheme: "audio",
      privileges: {
        standard: true,
        secure: true,
        stream: true,
        bypassCSP: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);

  app.setPath("userData", userdataDir);

  app.setAppUserModelId("com.squirrel.OpenOrpheus.OpenOrpheus");

  // Allow NCM to hack on `window.channel`
  // see https://github.com/electron/electron/blob/c2a0ec9931096ec83441521c8a75449cae96cd85/shell/renderer/api/electron_api_context_bridge.cc#L37
  // see https://github.com/YUCLing/open-orpheus/pull/105#issue-4520228513
  app.commandLine.appendSwitch("enable-features", "ContextBridgeMutability");
  app.commandLine.appendSwitch("disable-features", "MediaSessionService");

  if (existsSync(disableHardwareAccelerationFlag)) {
    app.disableHardwareAcceleration();
  }

  if (app.isPackaged && !checkEnvFlagPresent("ENABLE_ELECTRON_MENUS"))
    // Tell Electron we don't need a menu before Electron tries to create one,
    // this benefits the startup time
    Menu.setApplicationMenu(null);
}
