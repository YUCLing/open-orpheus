import Emittery from "emittery";
import { Keyv, KeyvHooks } from "keyv";
import { KeyvSqlite } from "@keyv/sqlite";

import { SETTINGS_DEFAULTS, type SettingsValue } from "@shared/settings/defaults";
import { SettingsEvents } from "@shared/types/settings";
import createKeyvSqliteDriver from "./database/KeyvSqliteDriver";
import { nativeDb } from "./database";
import { registerShutdownTask } from "./lifecycle";

/**
 * Default for a key, `undefined` when it has none. Unknown keys (plugins and
 * forward compatibility) are looked up as well, so the table is read loosely.
 */
function lookupDefault(key: string): unknown {
  return (SETTINGS_DEFAULTS as Record<string, unknown>)[key];
}

/**
 * The settings store.
 *
 * Keys declared in `SETTINGS_DEFAULTS` are typed from their default; any other
 * key (plugins, forward compatibility) resolves to `unknown`. The single
 * generic signature keeps a wrong value for a known key an error while leaving
 * the store open to unknown keys.
 */
export type SettingsStore = {
  get(keys: string[]): Promise<(unknown | undefined)[]>;
  get<K extends string>(key: K): Promise<SettingsValue<K>>;
  getMany<K extends string>(keys: K[]): Promise<(SettingsValue<K> | undefined)[]>;
  set<K extends string>(key: K, value: SettingsValue<K>, ttl?: number): Promise<boolean>;
} & Omit<Keyv, "get" | "set" | "getMany">;

export let kv: SettingsStore;
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
  LOGGER.debug(
    { entries: Object.keys(SETTINGS_DEFAULTS).length },
    "Initializing the settings store"
  );

  const store = new Keyv({
    namespace: "settings",
    store: new KeyvSqlite({
      driver: createKeyvSqliteDriver(nativeDb),
    }),
  });

  const get = store.get.bind(store);
  store.get = async (keyOrKeys) => {
    if (Array.isArray(keyOrKeys)) return get(keyOrKeys);
    const ret = await get(keyOrKeys);
    const defaultValue = lookupDefault(keyOrKeys);
    if (ret === undefined && defaultValue !== undefined) return defaultValue;
    return ret;
  };

  const getMany = store.getMany.bind(store);
  store.getMany = async (keys) => {
    const ret = await getMany(keys);
    for (let i = 0; i < keys.length; i++) {
      const defaultValue = lookupDefault(keys[i]);
      if (ret[i] === undefined && defaultValue !== undefined) ret[i] = defaultValue as never;
    }
    return ret;
  };

  events = new Emittery();
  const set = store.set.bind(store);
  store.set = async (key, value, ttl) => {
    const result = await set(key, value, ttl);
    if (result) {
      LOGGER.debug({ key }, "Setting updated");
      void events.emit("change", { key, value });
    }
    return result;
  };
  store.onHook(KeyvHooks.AFTER_SET_MANY, ({ entries, values }) => {
    for (const [index, { key, value }] of entries.entries()) {
      if (values[index] !== true) continue;
      LOGGER.debug({ key }, "Setting updated");
      void events.emit("change", { key, value });
    }
  });
  store.onHook(KeyvHooks.AFTER_DELETE, ({ key, value }) => {
    const keys = Array.isArray(key) ? key : [key];
    const results = Array.isArray(value) ? value : [value];
    keys.forEach((key, index) => {
      if (results[index] === true) void events.emit("delete", { key });
    });
  });

  kv = store;
}
