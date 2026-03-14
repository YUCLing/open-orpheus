import { contextBridge, ipcRenderer } from "electron";

export default function () {
  contextBridge.executeInMainWorld({
    func: (apiKey) => {
      const w = window as {
        BETTERNCM_API_KEY?: string;
        BETTERNCM_API_PORT?: number;
        BETTERNCM_API_PATH?: string;
        BETTERNCM_FILES_PATH?: string;
      };
      w.BETTERNCM_API_KEY = apiKey;
      w.BETTERNCM_API_PORT = 0;
      w.BETTERNCM_API_PATH = `betterncm://api`;
      w.BETTERNCM_FILES_PATH = `betterncm://local`;
      addEventListener("DOMContentLoaded", () => {
        const s = document.createElement("script");
        s.src = "betterncm://betterncm/framework.js";
        s.onload = () => {
          // Begin loading BetterNCM after the framework script is loaded
          window.dispatchEvent(new Event("loadbetterncm"));
        };
        document.head.appendChild(s);
      });
    },
    args: [ipcRenderer.sendSync("betterncm.apiKey")],
  });
}
