import { Database } from "@open-orpheus/database";

import { installDatabaseService } from "../database";
import { installSettingsService } from "../settings";
import { createDatabaseService } from "./services/database";
import { createSettingsService } from "./services/settings";
import type { HostDeps, ReadyPhase } from "./types";

export async function bootstrap(deps: HostDeps): Promise<ReadyPhase> {
  const openDatabase = deps.openDatabase ?? ((path) => new Database(path));

  const database = await createDatabaseService({ openDatabase });
  installDatabaseService(database);

  const settings = createSettingsService({ database });
  installSettingsService(settings);

  return { logger: deps.logger, database, settings };
}
