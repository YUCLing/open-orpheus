import { resolve } from "node:path";

import { KeyvSqlite } from "@keyv/sqlite";
import { Database } from "@open-orpheus/database";

import { cache } from "./folders";
import type { MainWindowAccessor } from "./bootstrap/types";
import LyricCacheManager from "./cache/LyricCahceManager";
import PlayCacheManager from "./cache/PlayCacheManager";
import HttpCacheStorage from "./cache/HttpCacheStorage";
import createKeyvSqliteDriver from "./database/KeyvSqliteDriver";

export let lyricCacheManager: LyricCacheManager | null = null;
export let playCacheManager: PlayCacheManager | null = null;
export let httpCacheStorage: HttpCacheStorage | null = null;

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
