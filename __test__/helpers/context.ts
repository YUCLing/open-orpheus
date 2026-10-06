import type { Database } from "@open-orpheus/database";
import type { Logger } from "pino";
import { vi } from "vitest";

// The graph reaches three boundaries Vitest cannot provide on its own: the native
// SQLite driver behind keyv, and electron for the app's own data paths. These are
// process/vendor boundaries, not our modules, so mocking them here is what keeps
// `createTestContext` free of any own-module mock.
vi.mock("keyv", () => {
  class Keyv {
    get = vi.fn(async () => undefined);
    getMany = vi.fn(async (keys: string[]) => keys.map(() => undefined));
    set = vi.fn(async () => true);
    delete = vi.fn(async () => true);
    onHook = vi.fn();
  }
  return {
    Keyv,
    KeyvHooks: { BEFORE_SET: "before:set", AFTER_DELETE: "after:delete" },
  };
});
vi.mock("@keyv/sqlite", () => ({ KeyvSqlite: class {} }));
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/open-orpheus-test", isPackaged: false },
}));

/** A logger with no transport, for graph construction under test. */
export function createTestLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    silent: vi.fn(),
    child: vi.fn(() => createTestLogger()),
  } as unknown as Logger;
}

/** An in-memory stand-in for the napi-rs database handle. */
export function createFakeDatabase(): Database {
  return {
    executeSql: vi.fn(async () => ({})),
    executeSqls: vi.fn(async () => ({})),
    exec: vi.fn(async () => ({})),
  } as unknown as Database;
}

export interface TestContextOverrides {
  logger?: Logger;
  /** Records the paths the graph opens; defaults to a fresh fake per path. */
  openDatabase?: (path: string) => Database;
}

/**
 * Boot the real composition root with test doubles at every boundary, so specs
 * exercise the actual graph rather than a re-declared one. `bootstrap` is imported
 * lazily on purpose: the mocks above are registered when this module is evaluated,
 * and a static import here would depend on the caller's import order.
 */
export async function createTestContext(overrides: TestContextOverrides = {}) {
  const { bootstrap } = await import("@main/bootstrap/context");

  return bootstrap({
    logger: overrides.logger ?? createTestLogger(),
    openDatabase: overrides.openDatabase ?? (() => createFakeDatabase()),
  });
}
