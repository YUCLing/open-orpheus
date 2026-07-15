import os from "node:os";
import path, { resolve } from "node:path";
import { readdir, stat, rm } from "node:fs/promises";

import { app, BrowserWindow, Menu } from "electron";
import packManager from "../pack";
import WebPack from "../packs/WebPack";
import { wasm as wasmDir } from "../folders";
import {
  httpCacheStorage,
  lyricCacheManager,
  playCacheManager,
} from "../cache";
import { checkUpdate } from "../update";
import { registerIpcHandlers } from "../../bridge/register";
import type { ManageContract } from "../../bridge/contracts/manage-api";
import registerAsProtocolClient, {
  getProtocolClientName,
  isProtocolClient,
  unregisterAsProtocolClient,
} from "../protocol";
import { registerSettingsHandlers } from "../../bridge/common/settings";
import { font } from "../gui";

let manageWndInstance: BrowserWindow | null = null;

export default function showManageWindow() {
  if (manageWndInstance && !manageWndInstance.isDestroyed()) {
    manageWndInstance.focus();
    return;
  }

  const manageWnd = new BrowserWindow({
    title: "管理 Open Orpheus",
    width: 1000,
    height: 600,
    show: true,
    webPreferences: {
      partition: "open-orpheus",
      preload: path.join(__dirname, "manage.js"),
    },
  });
  manageWndInstance = manageWnd;
  manageWnd.on("closed", () => {
    manageWndInstance = null;
  });
  manageWnd.setMenuBarVisibility(false);
  if (GUI_VITE_DEV_SERVER_URL) {
    manageWnd.loadURL(GUI_VITE_DEV_SERVER_URL);
  } else {
    manageWnd.loadURL("gui://frontend/");
  }
  registerIpcHandlers<ManageContract>(manageWnd.webContents, "manage", {
    getFont: async () => font,
    checkUpdate: async (event, ignoreCache = false) =>
      await checkUpdate(ignoreCache),

    pack: {
      getWebPackCommitHash: async () => {
        return packManager.getPack<WebPack>("web").getCommitHash();
      },
      redownloadPackage: async () => {
        app.relaunch({
          args: process.argv.slice(1).concat(["--redownload-package"]),
        });
        app.quit();
      },
    },

    cache: {
      getStats: async () => {
        const [playCacheInfo, httpStats, lyrics, wasm] = await Promise.all([
          playCacheManager?.getInfo(),
          (async () => {
            if (!httpCacheStorage) return undefined;
            const [entryCount, sizeBytes, sizeBytesOnDisk] = await Promise.all([
              httpCacheStorage.entryCount(),
              httpCacheStorage.totalSize(),
              httpCacheStorage.diskSize(),
            ]);
            return { entryCount, sizeBytes, sizeBytesOnDisk };
          })(),
          lyricCacheManager?.getStats(),
          (async () => {
            try {
              const entries = await readdir(wasmDir, { withFileTypes: true });
              const files = entries.filter((e) => e.isFile());
              let sizeBytes = 0;
              await Promise.all(
                files.map(async (f) => {
                  try {
                    const s = await stat(resolve(wasmDir, f.name));
                    sizeBytes += s.size;
                  } catch {
                    // Skip
                  }
                })
              );
              return { entryCount: files.length, sizeBytes };
            } catch {
              return { entryCount: 0, sizeBytes: 0 };
            }
          })(),
        ]);

        return {
          play: {
            entryCount:
              (await playCacheManager?.queryCacheTracks())?.length || 0,
            sizeBytes: Math.round(
              (playCacheInfo?.currentCachedSize || 0) * 1024 * 1024 * 1024
            ),
          },
          http: httpStats ?? { entryCount: 0, sizeBytes: 0 },
          lyrics: lyrics ?? { entryCount: 0, sizeBytes: 0 },
          wasm,
        };
      },
      clearResources: async (_event, category) => {
        if (category === "http") {
          await httpCacheStorage?.clear();
        } else if (category === "http:vacuum") {
          await httpCacheStorage?.vacuum();
        } else if (category === "lyrics") {
          await lyricCacheManager?.clear();
        } else if (category === "wasm") {
          await rm(wasmDir, { recursive: true, force: true });
        }
      },
    },

    protocol: {
      isClient: async () => {
        return isProtocolClient();
      },
      getClientName: async () => {
        return getProtocolClientName();
      },
      setAsClient: async (event, isClient) => {
        if (isClient) {
          registerAsProtocolClient(true);
        } else {
          unregisterAsProtocolClient();
        }
      },
    },

    gpu: {
      openInfo: async () => {
        new BrowserWindow({
          width: 800,
          height: 600,
          webPreferences: {
            partition: "open-orpheus",
          },
        }).loadURL("chrome://gpu");
      },
    },

    menu: {
      enableDefaultMenu: async () => {
        const macAppMenu: Electron.MenuItemConstructorOptions = {
          role: "appMenu",
        };
        const template: Electron.MenuItemConstructorOptions[] = [
          ...(os.platform() === "darwin" ? [macAppMenu] : []),
          { role: "fileMenu" },
          { role: "editMenu" },
          { role: "viewMenu" },
          { role: "windowMenu" },
        ];

        const menu = Menu.buildFromTemplate(template);
        Menu.setApplicationMenu(menu);
      },
    },
  });
  registerSettingsHandlers(manageWnd);
}

export function setManageWindowFont(font: string | null) {
  manageWndInstance?.webContents.send("manage.setFont", font);
}
