import type { Database } from "@open-orpheus/database";

import type { DatabaseService } from "./bootstrap/types";

export let webDb: Database;
export let musicLibraryDb: Database;
export let nativeDb: Database;

export function installDatabaseService(service: DatabaseService) {
  webDb = service.webDb;
  musicLibraryDb = service.musicLibraryDb;
  nativeDb = service.nativeDb;
}
