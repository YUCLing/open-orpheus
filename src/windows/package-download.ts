import { contextBridge, ipcRenderer } from "electron";
import { DownloadPackageProgress } from "src/main/pack";

contextBridge.exposeInMainWorld(
  "downloadPackage",
  function (callback: (progress: DownloadPackageProgress) => void) {
    const listener = (
      event: Electron.IpcRendererEvent,
      progress: DownloadPackageProgress
    ) => {
      if (progress.step === "completed") {
        ipcRenderer.off("download-package-progress", listener);
      }
      callback(progress);
    };
    ipcRenderer.on("download-package-progress", listener);
    ipcRenderer.send("download-package");
  }
);
