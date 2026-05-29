// Known entries, undefined refers to no default value
const KV_ENTRIES: Record<string, unknown> = {
  "audio.currentDevice": undefined,
  "desktopLyrics.interpolatedLyricLine": true,
  "tray.clickBehavior": "always-show-menu",
  "window.overrideMainWindowSizeLimit": undefined,
  proxy: undefined,
};

import Emittery from "emittery";
import { Keyv, KeyvHooks } from "keyv";

import { SettingsEvents } from "$sharedTypes/settings";
import { getNativeDbKvDriver } from "./database";

export let kv: Keyv;
export let events: Emittery<SettingsEvents>;

export function initialize() {
  kv = new Keyv({ namespace: "settings", store: getNativeDbKvDriver() });

  const get = kv.get.bind(kv);
  kv.get = async (keyOrKeys, ...args: undefined[]) => {
    if (Array.isArray(keyOrKeys)) return get(keyOrKeys, ...args);
    const ret = await get(keyOrKeys, ...args);
    const defaultValue = KV_ENTRIES[keyOrKeys];
    if (ret === undefined && defaultValue !== undefined) return defaultValue;
    return ret;
  };

  const getMany = kv.getMany.bind(kv);
  kv.getMany = async (keys, ...args: undefined[]) => {
    const ret = await getMany(keys, ...args);
    for (let i = 0; i < keys.length; i++) {
      const defaultValue = KV_ENTRIES[keys[i]];
      if (ret === undefined && defaultValue !== undefined)
        ret[i] = defaultValue as never;
    }
    return ret;
  };

  events = new Emittery();
  kv.hooks.addHandler(KeyvHooks.PRE_SET, ({ key, value }) => {
    events.emit("change", { key, value });
  });
  kv.hooks.addHandler(KeyvHooks.POST_DELETE, (data) => {
    const keys: string[] = Array.isArray(data) ? data : [data];
    keys.forEach((v) => events.emit("delete", { key: v }));
  });
}
