import { join } from "node:path";

import { Database } from "@open-orpheus/database";

import { data } from "./folders";

const pathToWebDb = join(data, "webdb.dat");
const pathToMusicLibrary = join(data, "library.dat");
const pathToNativeDb = join(data, "openorpheus.db");

export let webDb: Database;
export let musicLibraryDb: Database;
export let nativeDb: Database;

export async function initializeDatabases() {
  webDb = new Database(pathToWebDb);
  musicLibraryDb = new Database(pathToMusicLibrary);

  await musicLibraryDb.executeSql(`CREATE TABLE IF NOT EXISTS track (
  file TEXT,
  tid TEXT,
  aid TEXT,
  dir TEXT,
  title TEXT,
  album TEXT,
  genre TEXT,
  artist TEXT,
  duration REAL,
  timestamp INTEGER,
  bitrate INTEGER,
  filesize INTEGER,
  ignored INTEGER DEFAULT 0,
  id TEXT,
  artistid TEXT DEFAULT "",
  parentdir TEXT DEFAULT "",
  track TEXT,
  librarypath TEXT DEFAULT "",
  tracknumber INTEGER,
  source TEXT DEFAULT "",
  starttime REAL DEFAULT 0,
  type INTEGER DEFAULT 0
)`);

  await musicLibraryDb.executeSqls([
    "CREATE INDEX IF NOT EXISTS file_index      ON track (file ASC);",
    "CREATE INDEX IF NOT EXISTS dir_index       ON track (dir ASC);",
    "CREATE INDEX IF NOT EXISTS id_index        ON track (id ASC);",
    "CREATE INDEX IF NOT EXISTS parentdir_index ON track (parentdir ASC);",
  ]);

  nativeDb = new Database(pathToNativeDb);
  await nativeDb.exec("PRAGMA journal_mode = WAL;", []);
  await nativeDb.exec("PRAGMA synchronous = FULL;", []);

  LOGGER.debug(
    { webDb: pathToWebDb, musicLibrary: pathToMusicLibrary, nativeDb: pathToNativeDb },
    "Opened databases"
  );
}
