import { contextBridge, ipcRenderer } from "electron";

import type { DownloadPackageProgress } from "../main/pack";
import { PackageDownloadReason } from "@shared/types/package-download";

let downloadReason = PackageDownloadReason.NotFound;

for (let i = 0; i < process.argv.length; i++) {
  const item = process.argv[i];
  if (item.startsWith("--download-reason=")) {
    downloadReason = parseInt(item.substring("--download-reason=".length)) as PackageDownloadReason;
    break;
  }
}

contextBridge.exposeInMainWorld("downloadReason", downloadReason);

contextBridge.exposeInMainWorld(
  "downloadPackage",
  function (callback: (progress: DownloadPackageProgress) => void) {
    if (!(downloadReason in PackageDownloadReason)) {
      LOGGER.warn({ reason: downloadReason }, "Unexpected package download reason");
    }
    LOGGER.info({ reason: downloadReason }, "Package download started");
    const listener = (event: Electron.IpcRendererEvent, progress: DownloadPackageProgress) => {
      if (progress.step === "completed") {
        LOGGER.info({ reason: downloadReason }, "Package download completed");
        ipcRenderer.off("download-package-progress", listener);
      }
      callback(progress);
    };
    ipcRenderer.on("download-package-progress", listener);
    ipcRenderer.send("download-package");
  }
);
