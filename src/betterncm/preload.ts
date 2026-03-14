import { contextBridge, ipcRenderer } from "electron";

import inject from "./preload/inject";
import { VERSION } from "./constants";

const isBetterNCMPresent = ipcRenderer.sendSync("betterncm.isPresent");

if (isBetterNCMPresent) {
  inject();

  contextBridge.exposeInMainWorld("betterncm_native", {
    app: {
      version: () => {
        return VERSION;
      },
    },
    fs: {
      readDir: (path: string) => {
        return ipcRenderer.sendSync("betterncm.fs.readDir", path);
      },
      readFileText: (path: string) => {
        return ipcRenderer.sendSync("betterncm.fs.readFileText", path);
      },
      exists: (path: string) => {
        return ipcRenderer.sendSync("betterncm.fs.exists", path);
      },
    },
  });
}
