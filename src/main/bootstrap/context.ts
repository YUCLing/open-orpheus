import { Database } from "@open-orpheus/database";

import { installDatabaseService } from "../database";
import {
  events as lifecycleEvents,
  installLifecycleService,
} from "../lifecycle";
import { installSettingsService } from "../settings";
import { createDatabaseService } from "./services/database";
import { createLifecycleService } from "./services/lifecycle";
import { createSettingsService } from "./services/settings";
import { windowService } from "./services/window";
import type { HostDeps, ReadyPhase } from "./types";

export async function bootstrap(deps: HostDeps): Promise<ReadyPhase> {
  const lifecycle = createLifecycleService({
    logger: deps.logger,
    events: lifecycleEvents,
  });
  installLifecycleService(lifecycle);

  const openDatabase = deps.openDatabase ?? ((path) => new Database(path));

  const database = await createDatabaseService({ openDatabase });
  installDatabaseService(database);

  const settings = createSettingsService({ database });
  installSettingsService(settings);

  return {
    logger: deps.logger,
    lifecycle,
    windows: windowService,
    database,
    settings,
  };
}
