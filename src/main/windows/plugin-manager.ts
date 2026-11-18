import path from "node:path";

import { ManagedWindow } from "@main/window";
import { registerIpcHandlers } from "@main/bridge/register";
import { getPluginManager } from "@main/plugin";
import type { PluginManagerContract } from "@shared/contracts/plugin-manager-api";

export class PluginManagerWindow extends ManagedWindow {
  constructor() {
    super();
    const wnd = this.createBrowserWindow({
      width: 1000,
      height: 600,
      title: "Open Orpheus 插件管理",
      show: true,
      frame: true,
      webPreferences: {
        partition: "open-orpheus",
        preload: path.join(import.meta.dirname, "plugin-manager.cjs"),
      },
    });
    this.hideMenuBar();
    this.loadGuiRoute("/plugin-manager");
    registerIpcHandlers<PluginManagerContract>(wnd.webContents, "plugin", {
      list: async () => getPluginManager()?.list() ?? { available: false, plugins: [] },
      setEnabled: async (_event, id: string, enabled: boolean) => {
        const manager = getPluginManager();
        if (!manager) throw new Error("Plugin system is disabled");
        return manager.setEnabled(id, enabled);
      },
    });
  }
}

let existingWindow: PluginManagerWindow | null = null;
export default function showPluginManagerWindow() {
  if (existingWindow) {
    existingWindow.window?.focus();
    return;
  }
  existingWindow = new PluginManagerWindow();
  existingWindow.window?.on("closed", () => {
    existingWindow = null;
  });
}
