import { app, BrowserWindow, screen } from "electron";
import path from "node:path";
import started from "electron-squirrel-startup";

// Orpheus scheme
import registerOrpheusScheme from "./main/orpheus";

// Channel module
import "./main/channel";

import { bindMainWindow as trayBindMainWindow } from "./main/tray";
import { getWindowSizeStatus } from "./main/util";
import { loadFromFile as loadCookiesFromFile } from "./main/cookie";
import { data as dataDir } from "./main/folders";
import { prepareDeviceId } from "./main/device";
import { addWindow } from "./main/window";

let quitting = false;

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

app.commandLine.appendSwitch("remote-debugging-port", "6546");
app.setPath("userData", path.resolve(path.join(dataDir, "userdata")));

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

  addWindow(mainWindow);

  // Load App URL
  mainWindow.loadURL("orpheus://orpheus/pub/app.html");

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
app.on("ready", async () => {
  registerOrpheusScheme();

  await prepareDeviceId();
  await loadCookiesFromFile(path.join(dataDir, "cookies.dat"));

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
