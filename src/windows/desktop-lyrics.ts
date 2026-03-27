import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktopLyrics", {
  dragWindow: () => {
    ipcRenderer.send("drag-window");
  },
});
