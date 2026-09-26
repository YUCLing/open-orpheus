import path from "node:path";

import type { BrowserWindowConstructorOptions } from "electron";

import packManager from "../pack";
import { PackageDownloadReason } from "$sharedTypes/package-download";
import { ManagedWindow } from "../window";

const packageDownloadWindowOptions = {
  width: 1000,
  height: 600,
  title: "Open Orpheus",
  show: true,
  frame: true,
  webPreferences: {
    partition: "open-orpheus",
    preload: path.join(import.meta.dirname, "package-download.js"),
  },
} satisfies BrowserWindowConstructorOptions;

class PackageDownloadWindow extends ManagedWindow {
  constructor(downloadReason: PackageDownloadReason) {
    super();
    this.createBrowserWindow({
      ...packageDownloadWindowOptions,
      webPreferences: {
        ...packageDownloadWindowOptions.webPreferences,
        additionalArguments: [`--download-reason=${downloadReason.toString()}`],
      },
    });
    this.hideMenuBar();
    this.loadGuiRoute("/package-download");
  }

  /**
   * Resolves when the package finishes downloading, rejects with `"CANCEL"`
   * when the window is closed early.
   */
  show(): Promise<void> {
    const wnd = this.window;
    if (!wnd) {
      return Promise.reject(
        new Error("Package download window was not created")
      );
    }

    return new Promise<void>((resolve, reject) => {
      let downloadSuccess = false;
      wnd.webContents.ipc.on("download-package", () => {
        packManager
          .downloadPackage((progress) => {
            wnd.webContents.send("download-package-progress", progress);
            if (progress.step === "completed") {
              downloadSuccess = true;
              resolve();
              wnd.close();
            }
          })
          .catch((e) => {
            reject(e);
            wnd.close();
          });
      });
      wnd.on("closed", () => {
        if (!downloadSuccess) {
          reject("CANCEL");
        }
      });
    });
  }
}

export default function showPackgeDownloadWindow(
  downloadReason = PackageDownloadReason.LoadFailed
): Promise<void> {
  return new PackageDownloadWindow(downloadReason).show();
}
