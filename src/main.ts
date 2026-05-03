import {
  app,
  BrowserWindow,
  dialog,
  protocol,
  screen,
  session,
} from "electron";
import path from "node:path";
import os from "node:os";
import { mkdir } from "node:fs/promises";
import started from "electron-squirrel-startup";

// We want to hook Wayland connections as early as possible.
import "@open-orpheus/window";

import { onExit } from "@open-orpheus/lifecycle";

// Handle errors as early as possible
import "./main/error";

import { getWindowSizeStatus } from "./main/util";
import { data as dataDir, userdata as userdataDir } from "./main/folders";
import { prepareDeviceId } from "./main/device";
import { CORE_VERSION } from "./constants";
import { initializeDatabases } from "./main/database";
import packManager from "./main/pack";
import showPackgeDownloadWindow from "./main/windows/package-download";
import { setMainWindow } from "./main/window";
import {
  markStarted,
  started as appStarted,
  quitting,
  markQuitting,
} from "./main/lifecycle";
import { stringifyError } from "./util";

import type WebPack from "./main/packs/WebPack";

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// Enforce single instance
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
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
      corsEnabled: true,
    },
  },
]);

app.setPath("userData", userdataDir);

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // Load App URL
  mainWindow.loadURL("orpheus://orpheus/pub/app.html");

  setMainWindow(mainWindow);

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

  mainWindow.on("close", (e) => {
    if (quitting) return;
    mainWindow.webContents.send("channel.call", "winhelper.onclose");
    e.preventDefault();
  });
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on("ready", async () => {
  try {
    // Make sure data directory exists
    await mkdir(path.join(dataDir), { recursive: true });

    let userAgent = session.defaultSession.getUserAgent();
    if (os.platform() === "linux") {
      // Make some modules think we are indeed on desktop.
      userAgent = userAgent.replace(
        /^(Mozilla\/5\.0 \(([^)]*)\))/,
        "Mozilla/5.0 ($2; Windows NT 10.0; WOW64)"
      );
    }
    session.defaultSession.setUserAgent(
      `${userAgent} NeteaseMusicDesktop/${CORE_VERSION}`
    );

    const openOrpheusSession = session.fromPartition("open-orpheus");

    await import("./main/gui").then((m) => {
      // Register GUI scheme for Open Orpheus session now, package download window might need it
      m.default(openOrpheusSession.protocol);
    });

    const shouldRedownload = process.argv.includes("--redownload-package");
    try {
      // Trigger an error to redownload the package if requested
      if (shouldRedownload) throw new Error("REDOWNLOAD_REQ");
      await packManager.loadWebPack();
    } catch (e) {
      if (!(e instanceof Error) || e.message !== "REDOWNLOAD_REQ")
        console.warn("Failed to load web pack:", e);
      await showPackgeDownloadWindow(); // If user cancelled, this will throw and skip the rest of initialization
      if (shouldRedownload) {
        // Redownload is successfully here, drop the argument then restart again
        app.relaunch({
          args: process.argv.filter((v) => v !== "--redownload-package"),
        });
        app.quit();
        return;
      }
      await packManager.loadWebPack(); // Simply try loading again after download, it will throw if the package is still invalid
    }

    // Initialize schemes and get registrars
    const [registerOrpheusScheme, registerAudioScheme] = await Promise.all([
      import("./main/orpheus").then((m) => m.default),
      import("./main/audio").then((m) => m.default),
    ]);

    // Register for default session
    registerOrpheusScheme(protocol);
    registerAudioScheme(protocol);

    // Register for Open Orpheus session
    registerOrpheusScheme(openOrpheusSession.protocol);

    initializeDatabases();

    await Promise.all([
      import("./main/channel"),
      // Make sure we handle KV storage IPC calls
      import("./main/kv"),
      prepareDeviceId(),
      packManager.getPack<WebPack>("web").readPack(),
      import("./main/windows/desktop-lyrics").then((m) => {
        // Create desktop lyrics window
        m.default();
      }),
    ]);

    onExit(() => {
      app.quit(); // Graceful exit
    });

    createWindow();

    markStarted();

    // Run a update check
    import("./main/update").then((m) => m.checkUpdate());
  } catch (error) {
    if (error) {
      dialog.showErrorBox(
        "Initialization Failed",
        "An error occurred during application initialization. Open Orpheus will now exit.\n\nDetails:\n" +
          stringifyError(error)
      );
    }
    app.exit(1);
  }
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  // Make sure we don't quit because of package download window being closed before main window has started
  if (process.platform !== "darwin" && appStarted) {
    app.quit();
  }
});

app.on("activate", () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("before-quit", () => {
  // Allow some windows to be closed.
  markQuitting();
});

app.on("second-instance", () => {
  const [win] = BrowserWindow.getAllWindows();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
