import { app, BrowserWindow } from "electron";
import path from "node:path";
import started from "electron-squirrel-startup";

// Orpheus scheme
import registerOrpheusScheme from "./main/orpheus";

// Channel module
import "./main/channel";

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
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

      // Set CORS headers to allow requests from any origin
      responseHeaders["access-control-allow-origin"] = ["orpheus://orpheus"];
      responseHeaders["access-control-allow-methods"] = ["*"];
      responseHeaders["access-control-allow-headers"] = ["*"];
      responseHeaders["access-control-allow-credentials"] = ["true"];

      callback({ responseHeaders });
    }
  );

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
