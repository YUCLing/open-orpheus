import { resolve } from "node:path";

import { KeyvSqlite } from "@keyv/sqlite";
import { Database } from "@open-orpheus/database";

import { cache } from "../platform/folders";
import type { MainWindowAccessor } from "../bootstrap/types";
import { registerShutdownTask } from "./lifecycle";
import LyricCacheManager from "./cache/LyricCahceManager";
import PlayCacheManager from "./cache/PlayCacheManager";
import HttpCacheStorage from "./cache/HttpCacheStorage";
import createKeyvSqliteDriver from "./database/KeyvSqliteDriver";

export let lyricCacheManager: LyricCacheManager | null = null;
export let playCacheManager: PlayCacheManager | null = null;
export let httpCacheStorage: HttpCacheStorage | null = null;

// Close the HTTP cache's SQLite store on shutdown. Registered at module scope so
// it is only ever added once, even though `createCacheManager` can run again
// when the renderer re-initialises storage. A no-op if the cache was never
// created.
registerShutdownTask({
  name: "http-cache",
  timeoutMs: 1000,
  run: async () => {
    await httpCacheStorage?.disconnect();
  },
});

export default function createCacheManager(windows: MainWindowAccessor) {
  lyricCacheManager = new LyricCacheManager(resolve(cache, "lyrics"));
  playCacheManager = new PlayCacheManager(resolve(cache, "play"), windows);
  httpCacheStorage = new HttpCacheStorage(
    new KeyvSqlite({
      iterationLimit: 500,
      driver: createKeyvSqliteDriver(new Database(resolve(cache, "http.db"))),
    })
  );
}
