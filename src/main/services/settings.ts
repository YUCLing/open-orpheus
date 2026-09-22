import { KeyvSqlite } from "@keyv/sqlite";
import Emittery from "emittery";
import { Keyv, KeyvHooks } from "keyv";

import type { SettingsEvents } from "@shared/types/settings";
import createKeyvSqliteDriver from "./database/KeyvSqliteDriver";
import type { DatabaseService, SettingsService } from "../bootstrap/types";

const KV_ENTRIES: Record<string, unknown> = {
  "audio.currentDevice": undefined,
  "desktopLyrics.interpolatedLyricLine": true,
  "desktopLyrics.opacity": 1,
  "tray.clickBehavior": "always-show-menu",
  "window.overrideMainWindowSizeLimit": undefined,
  "window.lifecycle": "on-demand",
  proxy: undefined,
};

export function createSettingsService(deps: {
  database: Pick<DatabaseService, "nativeDb">;
}): SettingsService {
  const kv = new Keyv({
    namespace: "settings",
    store: new KeyvSqlite({
      driver: createKeyvSqliteDriver(deps.database.nativeDb),
    }),
  });

  const get = kv.get.bind(kv);
  kv.get = async (keyOrKeys) => {
    if (Array.isArray(keyOrKeys)) return get(keyOrKeys);
    const ret = await get(keyOrKeys);
    const defaultValue = KV_ENTRIES[keyOrKeys];
    if (ret === undefined && defaultValue !== undefined) return defaultValue;
    return ret;
  };

  const getMany = kv.getMany.bind(kv);
  kv.getMany = async (keys) => {
    const ret = await getMany(keys);
    for (let i = 0; i < keys.length; i++) {
      const defaultValue = KV_ENTRIES[keys[i]];
      if (ret[i] === undefined && defaultValue !== undefined)
        ret[i] = defaultValue as never;
    }
    return ret;
  };

  const events = new Emittery<SettingsEvents>();
  kv.onHook(KeyvHooks.BEFORE_SET, ({ key, value }) => {
    events.emit("change", { key, value });
  });
  kv.onHook(KeyvHooks.AFTER_DELETE, ({ key }) => {
    const keys = Array.isArray(key) ? key : [key];
    keys.forEach((key) => events.emit("delete", { key }));
  });

  return { kv, events };
}
