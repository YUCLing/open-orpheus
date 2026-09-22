import { registerIpcHandlers } from "../register";
import { SettingsContract } from "../contracts/settings-api";
import type { SettingsService } from "../../main/bootstrap/types";
import {
  combineDisposables,
  toDisposable,
  type Disposable,
} from "@shared/disposable";

export function registerSettingsHandlers(
  wnd: Electron.BrowserWindow,
  settings: Pick<SettingsService, "kv" | "events">
): Disposable {
  const ipc = registerIpcHandlers<SettingsContract>(
    wnd.webContents,
    "settings",
    {
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
    }
  );

  const unlistenChange = settings.events.on("change", (e) => {
    wnd.webContents.send("settings.change", e.data.key, e.data.value);
  });
  const unlistenDelete = settings.events.on("delete", (e) => {
    wnd.webContents.send("settings.delete", e.data.key);
  });

  const disposable = combineDisposables(
    ipc,
    toDisposable(unlistenChange),
    toDisposable(unlistenDelete)
  );

  // The window closing stays the trigger in production, so this is not a
  // behaviour change; the returned handle is what lets an owner tear the
  // registration down earlier instead.
  wnd.on("closed", () => disposable.dispose());

  return disposable;
}
