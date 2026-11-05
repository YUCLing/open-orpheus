import os from "node:os";
import path from "node:path";

import { BrowserWindow, screen } from "electron";
import type { BrowserWindowConstructorOptions } from "electron";

import { ManagedWindow, setMainWindow } from "../window";
import { sendIfAlive } from "../util/send";
import { window as miniPlayerWindow } from "./mini-player";
import { LifecycleState, setLifecycleState } from "../lifecycle";
import { toError } from "@shared/util";

function getWindowState(wnd: BrowserWindow): "minimize" | "maximize" | "restore" {
  return wnd.isMinimized() ? "minimize" : wnd.isMaximized() ? "maximize" : "restore";
}

function getWindowSizeStatus(
  wnd: BrowserWindow
): ["minimize" | "maximize" | "restore", number, number, number] {
  const bounds = wnd.getContentBounds();
  const scaleFactor = screen.getDisplayMatching(bounds).scaleFactor;
  return [
    getWindowState(wnd),
    bounds.width * scaleFactor,
    bounds.height * scaleFactor,
    scaleFactor,
  ];
}

const mainWindowOptions = {
  width: 1280,
  height: 720,
  show: false,
  frame: false,
  webPreferences: {
    preload: path.join(import.meta.dirname, "preload.cjs"),
    additionalArguments: ["--preload-channel=main"],
  },
} satisfies BrowserWindowConstructorOptions;

/** Wire the main window's cross-window behaviour and lifecycle. */
function setupMainWindow(mainWindow: BrowserWindow) {
  const isLinux = os.platform() === "linux";

  const sendSizeStatus = () => {
    sendIfAlive(
      mainWindow,
      "channel.call",
      "winhelper.onSizeStatus",
      ...getWindowSizeStatus(mainWindow)
    );
  };

  const sendResizeDone = () => {
    const bounds = mainWindow.getContentBounds();
    const scaleFactor = screen.getDisplayMatching(bounds).scaleFactor;
    sendIfAlive(mainWindow, "channel.call", "winhelper.onsizeWindowDone", {
      top: 0,
      left: 0,
      right: bounds.width * scaleFactor,
      bottom: bounds.height * scaleFactor,
      deviceScaleFactor: scaleFactor,
    });
  };

  if (isLinux) {
    // Linux does not emit "resized", so debounce "resize" to emulate resize-end.
    // LayoutStore checks onSizeStatus against the window size snapshot it took
    // before handling the event, so onsizeWindowDone must arrive before that
    // check and carry physical pixels (the renderer divides them by
    // devicePixelRatio to get DIP).
    const sendSizeDoneAndStatus = () => {
      const [status, width, height, scaleFactor] = getWindowSizeStatus(mainWindow);
      sendIfAlive(mainWindow, "channel.call", "winhelper.onsizeWindowDone", {
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        deviceScaleFactor: scaleFactor,
      });
      sendIfAlive(
        mainWindow,
        "channel.call",
        "winhelper.onSizeStatus",
        status,
        width,
        height,
        scaleFactor
      );
    };

    // TODO(maybe): Some layout depends on windowWidth/windowHeight updating during
    // resize, but this only syncs them at resize-end.
    let resizeEndTimer: NodeJS.Timeout | undefined;

    mainWindow.on("resize", () => {
      if (resizeEndTimer) {
        clearTimeout(resizeEndTimer);
      }

      resizeEndTimer = setTimeout(sendSizeDoneAndStatus, 150);
    });

    mainWindow.on("maximize", sendSizeDoneAndStatus);
    mainWindow.on("minimize", sendSizeDoneAndStatus);
    mainWindow.on("restore", sendSizeDoneAndStatus);
  } else {
    mainWindow.on("maximize", sendSizeStatus);
    mainWindow.on("minimize", sendSizeStatus);
    mainWindow.on("restore", sendSizeStatus);
    // The order is intentional, the renderer will catch it since there's a debounce
    // for size status events
    mainWindow.on("resized", sendSizeStatus);
    mainWindow.on("resized", sendResizeDone);
  }

  mainWindow.on("focus", () => {
    sendIfAlive(mainWindow, "channel.call", "winhelper.onfocus");
  });
  mainWindow.on("blur", () => {
    sendIfAlive(mainWindow, "channel.call", "winhelper.onlosefocus");
  });

  mainWindow.on("show", () => {
    LOGGER.debug("Main window shown");
    // Make sure mini player doesn't show together with main window
    void miniPlayerWindow.hide();
  });

  setLifecycleState(LifecycleState.MainWindowCreated, mainWindow);

  // Load App URL
  LOGGER.debug("Loading main window");
  void mainWindow.loadURL("orpheus://orpheus/pub/app.html").then(
    () => LOGGER.info("Main window loaded"),
    (error) => LOGGER.error({ err: toError(error) }, "Failed to load main window")
  );

  setMainWindow(mainWindow);
}

class MainWindow extends ManagedWindow {
  constructor() {
    super();
    // Closing the main window asks the app to shut down; quitting closes it.
    this.requestCloseApproval(() => this.send("channel.call", "winhelper.onclose"));
    setupMainWindow(this.createBrowserWindow(mainWindowOptions));
    LOGGER.info({ windowId: this.id }, "Main window created");
  }
}

export default async function createMainWindow() {
  return new MainWindow();
}
