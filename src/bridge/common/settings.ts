import { registerIpcHandlers } from "../register";
import { SettingsContract } from "../contracts/settings-api";
import type { SettingsService } from "../../main/bootstrap/types";

export function registerSettingsHandlers(
  wnd: Electron.BrowserWindow,
  settings: Pick<SettingsService, "kv" | "events">
) {
  registerIpcHandlers<SettingsContract>(wnd.webContents, "settings", {
    async get(event, key) {
      return await settings.kv.get(key);
    },
    async set(event, key, value) {
      return await settings.kv.set(key, value);
    },
    async setMany(event, entries) {
      return await settings.kv.setMany(entries);
    },
    async delete(event, key) {
      return await settings.kv.delete(key);
    },
    async deleteMany(event, key) {
      return await settings.kv.deleteMany(key);
    },
  });

  const unlistenChange = settings.events.on("change", (e) => {
    wnd.webContents.send("settings.change", e.data.key, e.data.value);
  });
  const unlistenDelete = settings.events.on("delete", (e) => {
    wnd.webContents.send("settings.delete", e.data.key);
  });

  wnd.on("closed", () => {
    unlistenChange();
    unlistenDelete();
  });
}
