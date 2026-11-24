import Emittery from "emittery";
import { Keyv, KeyvHooks } from "keyv";
import { KeyvSqlite } from "@keyv/sqlite";

import { SETTINGS, type SettingsKey } from "@shared/settings";
import { SettingsEvents } from "@shared/types/settings";
import createKeyvSqliteDriver from "./database/KeyvSqliteDriver";
import { nativeDb } from "./database";
import { registerShutdownTask } from "./lifecycle";

// Known entries, undefined refers to no default value
const KV_ENTRIES = {
  [SETTINGS.kAudioCurrentDevice]: undefined,
  [SETTINGS.kDesktopLyricsInterpolatedLyricLine]: true,
  [SETTINGS.kDesktopLyricsOpacity]: 1,
  [SETTINGS.kDiscordPresenceEnabled]: false,
  [SETTINGS.kTrayClickBehavior]: "always-show-menu",
  [SETTINGS.kWindowOverrideMainWindowSizeLimit]: undefined,
  [SETTINGS.kWindowLifecycle]: "on-demand",
  [SETTINGS.kPluginsEnabled]: {},
  [SETTINGS.kProxy]: undefined,
  [SETTINGS.kUpdateAutoInstall]: undefined,
} satisfies Record<SettingsKey, unknown>;

/**
 * Default for a key, `undefined` when it has none. Unknown keys (plugins and
 * forward compatibility) are looked up as well, so the map is read loosely.
 */
function lookupDefault(key: string): unknown {
  return (KV_ENTRIES as Record<string, unknown>)[key];
}

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
  LOGGER.debug({ entries: Object.keys(KV_ENTRIES).length }, "Initializing the settings store");

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
    const defaultValue = lookupDefault(keyOrKeys);
    if (ret === undefined && defaultValue !== undefined) return defaultValue;
    return ret;
  };

  const getMany = kv.getMany.bind(kv);
  kv.getMany = async (keys) => {
    const ret = await getMany(keys);
    for (let i = 0; i < keys.length; i++) {
      const defaultValue = lookupDefault(keys[i]);
      if (ret[i] === undefined && defaultValue !== undefined) ret[i] = defaultValue as never;
    }
    return ret;
  };

  events = new Emittery();
  const set = kv.set.bind(kv);
  kv.set = async (key, value, ttl) => {
    const result = await set(key, value, ttl);
    if (result) {
      LOGGER.debug({ key }, "Setting updated");
      void events.emit("change", { key, value });
    }
    return result;
  };
  kv.onHook(KeyvHooks.AFTER_SET_MANY, ({ entries, values }) => {
    for (const [index, { key, value }] of entries.entries()) {
      if (values[index] !== true) continue;
      LOGGER.debug({ key }, "Setting updated");
      void events.emit("change", { key, value });
    }
  });
  kv.onHook(KeyvHooks.AFTER_DELETE, ({ key, value }) => {
    const keys = Array.isArray(key) ? key : [key];
    const results = Array.isArray(value) ? value : [value];
    keys.forEach((key, index) => {
      if (results[index] === true) void events.emit("delete", { key });
    });
  });
}
