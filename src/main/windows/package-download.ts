import path from "node:path";

import { BrowserWindow } from "electron";
import packManager from "../pack";

export default function showPackgeDownloadWindow(): Promise<void> {
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
      wnd.loadURL("gui://frontend/package-download");
    }
    wnd.webContents.ipc.on("download-package", () => {
      packManager.downloadPackage((progress) => {
        wnd.webContents.send("download-package-progress", progress);
        if (progress.step === "completed") {
          downloadSuccess = true;
          resolve();
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
