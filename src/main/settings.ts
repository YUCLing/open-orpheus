// Known entries, undefined refers to no default value
const KV_ENTRIES: Record<string, unknown> = {
  "audio.currentDevice": undefined,
  "desktopLyrics.geometry": undefined,
  "desktopLyrics.output": undefined,
  "desktopLyrics.interpolatedLyricLine": true,
  "desktopLyrics.opacity": 1,
  "tray.clickBehavior": "always-show-menu",
  "window.overrideMainWindowSizeLimit": undefined,
  "window.lifecycle": "on-demand",
  proxy: undefined,
};

import Emittery from "emittery";
import { Keyv, KeyvHooks } from "keyv";
import { KeyvSqlite } from "@keyv/sqlite";

import { SettingsEvents } from "$sharedTypes/settings";
import createKeyvSqliteDriver from "./database/KeyvSqliteDriver";
import { nativeDb } from "./database";
import { registerShutdownTask } from "./lifecycle";

export let kv: Keyv;
export let events: Emittery<SettingsEvents>;

// Close the settings store on shutdown. Registered here rather than in
// `initialize` so it can only ever be added once.
registerShutdownTask({
  name: "settings-store",
  timeoutMs: 1000,
  run: async () => {
    await kv?.disconnect();
  },
});

export function initialize() {
  kv = new Keyv({
    namespace: "settings",
    store: new KeyvSqlite({
      driver: createKeyvSqliteDriver(nativeDb),
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
      if (ret[i] === undefined && defaultValue !== undefined) ret[i] = defaultValue as never;
    }
    return ret;
  };

  events = new Emittery();
  kv.onHook(KeyvHooks.BEFORE_SET, ({ key, value }) => {
    void events.emit("change", { key, value });
  });
  kv.onHook(KeyvHooks.AFTER_DELETE, ({ key }) => {
    const keys = Array.isArray(key) ? key : [key];
    keys.forEach((key) => events.emit("delete", { key }));
  });
}
