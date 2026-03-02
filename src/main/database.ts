import { join } from "node:path";

import { Database } from "database";

const pathToWebDb = join("data", "webdb.dat");
const pathToMusicLibrary = join("data", "library.dat");

export const webDb = new Database(pathToWebDb);
export const musicLibraryDb = new Database(pathToMusicLibrary);
