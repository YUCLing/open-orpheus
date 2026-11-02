import { registerIpcHandlers } from "../register";
import { SettingsContract } from "@shared/contracts/settings-api";
import { kv, events } from "../../settings";

export function registerSettingsHandlers(wnd: Electron.BrowserWindow) {
  registerIpcHandlers<SettingsContract>(wnd.webContents, "settings", {
    async get(event, key) {
      return await kv.get(key);
    },
    async set(event, key, value) {
      return await kv.set(key, value);
    },
    async setMany(event, entries) {
      return await kv.setMany(entries);
    },
    async delete(event, key) {
      return await kv.delete(key);
    },
    async deleteMany(event, key) {
      return await kv.deleteMany(key);
    },
  });

  const unlistenChange = events.on("change", (e) => {
    LOGGER.debug({ key: e.data.key }, "Forwarded settings change");
    wnd.webContents.send("settings.change", e.data.key, e.data.value);
  });
  const unlistenDelete = events.on("delete", (e) => {
    LOGGER.debug({ key: e.data.key }, "Forwarded settings deletion");
    wnd.webContents.send("settings.delete", e.data.key);
  });

  wnd.on("closed", () => {
    unlistenChange();
    unlistenDelete();
  });
}
