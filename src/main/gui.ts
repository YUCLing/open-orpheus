import path from "node:path";

import { BrowserWindow } from "electron";
import { downloadPackage } from "./pack";

export function openPackageDownloadWindow(): Promise<void> {
  return new Promise((resolve, reject) => {
    let downloadSuccess = false;
    const wnd = new BrowserWindow({
      width: 1000,
      height: 600,
      title: "Open Orpheus",
      show: true,
      frame: true,
      webPreferences: {
        partition: "open-orpheus",
        preload: path.join(__dirname, "package-download.js"),
      },
    });
    wnd.setMenuBarVisibility(false);
    if (GUI_VITE_DEV_SERVER_URL) {
      wnd.loadURL(GUI_VITE_DEV_SERVER_URL + "/package-download");
    } else {
      wnd.loadFile(path.join(__dirname, "gui/package-download.html"));
    }
    wnd.webContents.ipc.on("download-package", () => {
      downloadPackage((progress) => {
        wnd.webContents.send("download-package-progress", progress);
        if (progress.step === "completed") {
          downloadSuccess = true;
          resolve();
          console.log("resolved");
          wnd.close();
        }
      });
    });
    wnd.on("closed", () => {
      if (!downloadSuccess) {
        reject();
      }
    });
  });
}
