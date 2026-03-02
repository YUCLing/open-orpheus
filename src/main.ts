import { app, BrowserWindow, screen } from "electron";
import path from "node:path";
import started from "electron-squirrel-startup";

// Orpheus scheme
import registerOrpheusScheme from "./main/orpheus";

// Channel module
import "./main/channel";
import { bindMainWindow as trayBindMainWindow } from "./main/tray";

let quitting = false;

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

function getWindowSizeStatus(
  wnd: BrowserWindow
): ["minimize" | "maximize" | "restore", number, number, number] {
  const bounds = wnd.getBounds();
  return [
    wnd.isMinimized() ? "minimize" : wnd.isMaximized() ? "maximize" : "restore",
    bounds.width,
    bounds.height,
    screen.getDisplayMatching(bounds).scaleFactor,
  ];
}

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // Load App URL
  mainWindow.loadURL("orpheus://orpheus/pub/app.html");

  // Fix CORS issues by injecting appropriate headers for all responses
  mainWindow.webContents.session.webRequest.onHeadersReceived(
    (details, callback) => {
      const frame = details.frame;
      if (!frame) {
        // No frame associated with the request, skip header modification
        callback({});
        return;
      }

      const responseHeaders = details.responseHeaders || {};

      // Remove existing headers that might interfere with our CORS settings
      for (const key in responseHeaders) {
        if (
          [
            "access-control-allow-origin",
            "access-control-allow-methods",
            "access-control-allow-headers",
            "access-control-allow-credentials",
          ].includes(key.toLowerCase())
        ) {
          delete responseHeaders[key];
        }
      }

      // Set CORS headers to allow requests from request origin
      responseHeaders["access-control-allow-origin"] = [frame.origin];
      responseHeaders["access-control-allow-methods"] = ["*"];
      responseHeaders["access-control-allow-headers"] = ["*"];
      responseHeaders["access-control-allow-credentials"] = ["true"];

      callback({ responseHeaders });
    }
  );

  trayBindMainWindow(mainWindow);

  ["maximize", "minimize", "restore", "resize"].forEach((event) => {
    mainWindow.on(event as unknown as "maximize", () => {
      mainWindow.webContents.send(
        "channel.call",
        "winhelper.onSizeStatus",
        ...getWindowSizeStatus(mainWindow)
      );
    });
  });

  mainWindow.on("resized", () => {
    const bounds = mainWindow.getBounds();
    mainWindow.webContents.send("channel.call", "winhelper.onsizeWindowDone", {
      top: 0,
      left: 0,
      right: bounds.width,
      bottom: bounds.height,
      deviceScaleFaactor: screen.getDisplayMatching(bounds).scaleFactor,
    });
  });

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

  // Open the DevTools.
  mainWindow.webContents.openDevTools();
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on("ready", () => {
  registerOrpheusScheme();

  createWindow();
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
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
  // Allow main window to be closed.
  quitting = true;
});
