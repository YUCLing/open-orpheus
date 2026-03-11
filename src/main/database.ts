import { join } from "node:path";

import { Database } from "@open-orpheus/database";

const pathToWebDb = join("data", "webdb.dat");
const pathToMusicLibrary = join("data", "library.dat");

let webDb: Database;
let musicLibraryDb: Database;

export function initializeDatabases() {
  webDb = new Database(pathToWebDb);
  musicLibraryDb = new Database(pathToMusicLibrary);
}

export function getWebDb() {
  return webDb;
}

export function getMusicLibraryDb() {
  return musicLibraryDb;
}
