import { join } from "node:path";

import { data } from "../../folders";
import type { DatabaseService, OpenDatabase } from "../types";

const MUSIC_LIBRARY_SCHEMA = `CREATE TABLE IF NOT EXISTS track (
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
)`;

const MUSIC_LIBRARY_INDEXES = [
  "CREATE INDEX IF NOT EXISTS file_index      ON track (file ASC);",
  "CREATE INDEX IF NOT EXISTS dir_index       ON track (dir ASC);",
  "CREATE INDEX IF NOT EXISTS id_index        ON track (id ASC);",
  "CREATE INDEX IF NOT EXISTS parentdir_index ON track (parentdir ASC);",
];

export async function createDatabaseService(deps: {
  openDatabase: OpenDatabase;
}): Promise<DatabaseService> {
  const webDb = deps.openDatabase(join(data, "webdb.dat"));
  const musicLibraryDb = deps.openDatabase(join(data, "library.dat"));

  await musicLibraryDb.executeSql(MUSIC_LIBRARY_SCHEMA);
  await musicLibraryDb.executeSqls(MUSIC_LIBRARY_INDEXES);

  const nativeDb = deps.openDatabase(join(data, "openorpheus.db"));
  await nativeDb.exec("PRAGMA journal_mode = WAL;", []);
  await nativeDb.exec("PRAGMA synchronous = FULL;", []);

  return { webDb, musicLibraryDb, nativeDb };
}
