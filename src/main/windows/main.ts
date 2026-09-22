import os from "node:os";
import path from "node:path";

import { BrowserWindow, screen } from "electron";

import { window as miniPlayerWindow } from "./mini-player";
import { LifecycleState } from "../lifecycle";
import type { WindowService } from "../bootstrap/types";
import type { LifecycleService } from "../services/lifecycle";

function getWindowState(
  wnd: BrowserWindow
): "minimize" | "maximize" | "restore" {
  return wnd.isMinimized()
    ? "minimize"
    : wnd.isMaximized()
      ? "maximize"
      : "restore";
}

function getWindowSizeStatus(
  wnd: BrowserWindow
): ["minimize" | "maximize" | "restore", number, number, number] {
  const bounds = wnd.getBounds();
  const screenScaleFactor = screen.getDisplayMatching(bounds).scaleFactor;
  // TODO: Confirm macOS desired behavior, Windows and Linux (Wayland) is already tested to be correct
  const scaleFactor = os.platform() === "win32" ? 1 : screenScaleFactor;
  return [
    getWindowState(wnd),
    bounds.width * scaleFactor,
    bounds.height * scaleFactor,
    screenScaleFactor,
  ];
}

export interface MainWindowDeps {
  windows: Pick<WindowService, "setMainWindow">;
  lifecycle: Pick<LifecycleService, "currentState" | "setLifecycleState">;
}

export default async function createMainWindow(deps: MainWindowDeps) {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    frame: false,
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.js"),
      additionalArguments: ["--preload-channel=main"],
    },
  });

  [
    "maximize",
    "minimize",
    "restore",
    os.platform() === "linux" ? "resize" : "resized",
  ].forEach((event) => {
    mainWindow.on(event as unknown as "maximize", () => {
      // resize is triggered instead of restore on Linux (Wayland)
      mainWindow.webContents.send(
        "channel.call",
        "winhelper.onSizeStatus",
        ...getWindowSizeStatus(mainWindow)
      );
    });
  });

  const sendResizeDone = () => {
    const bounds = mainWindow.getBounds();
    mainWindow.webContents.send("channel.call", "winhelper.onsizeWindowDone", {
      top: 0,
      left: 0,
      right: bounds.width,
      bottom: bounds.height,
      deviceScaleFaactor: screen.getDisplayMatching(bounds).scaleFactor,
    });
  };

  if (os.platform() !== "linux") {
    mainWindow.on("resized", sendResizeDone);
  } else {
    let resizeEndTimer: NodeJS.Timeout | undefined;

    mainWindow.on("resize", () => {
      if (resizeEndTimer) {
        clearTimeout(resizeEndTimer);
      }

      // Linux does not emit "resized", so debounce "resize" to emulate resize-end.
      resizeEndTimer = setTimeout(sendResizeDone, 150);
    });
  }

  mainWindow.on("focus", () => {
    mainWindow.webContents.send("channel.call", "winhelper.onfocus");
  });
  mainWindow.on("blur", () => {
    mainWindow.webContents.send("channel.call", "winhelper.onlosefocus");
  });

  mainWindow.on("show", () => {
    // Make sure mini player doesn't show together with main window
    miniPlayerWindow.hide();
  });

  mainWindow.on("close", (e) => {
    if (deps.lifecycle.currentState() === LifecycleState.Quitting) return;
    mainWindow.webContents.send("channel.call", "winhelper.onclose");
    e.preventDefault();
  });

  deps.lifecycle.setLifecycleState(
    LifecycleState.MainWindowCreated,
    mainWindow
  );

  mainWindow.loadURL("orpheus://orpheus/pub/app.html");

  deps.windows.setMainWindow(mainWindow);
}
