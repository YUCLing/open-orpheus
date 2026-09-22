import {
  createLifecycleService,
  events as lifecycleEvents,
  installLifecycleService,
} from "../services/lifecycle";
import { createDatabaseService } from "../services/database";
import { createSettingsService } from "../services/settings";
import { createWindowService } from "../services/window";
import type { HostDeps, OpenDatabase, ReadyPhase } from "./types";

export async function bootstrap(deps: HostDeps): Promise<ReadyPhase> {
  const lifecycle = createLifecycleService({
    logger: deps.logger,
    events: lifecycleEvents,
  });
  installLifecycleService(lifecycle);

  const openDatabase = deps.openDatabase ?? (await loadNativeDatabase());

  const database = await createDatabaseService({ openDatabase });

  const settings = createSettingsService({ database });

  return {
    logger: deps.logger,
    lifecycle,
    windows: createWindowService(),
    database,
    settings,
  };
}

/**
 * Resolves the native SQLite binding **only** when the caller supplied no
 * `openDatabase`.
 *
 * The import must stay dynamic. `@open-orpheus/database` loads a prebuilt
 * `*.node` binding from its own top-level code and throws when it is absent, so
 * a static import here would resolve the native package as soon as this module
 * is evaluated — before `deps.openDatabase` could ever be consulted, and
 * whether or not the caller passed one. That is what made the composition root
 * unbootable in a clean checkout: the substitute was never reached, because the
 * module failed to load first.
 */
async function loadNativeDatabase(): Promise<OpenDatabase> {
  const { Database } = await import("@open-orpheus/database");
  return (path) => new Database(path);
}
