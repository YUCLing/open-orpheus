import { vi } from "vitest";

/**
 * The main process gets a global `LOGGER` injected at build time by
 * `build-plugins/LoggerPlugin.ts`. Modules under `src/main` reference that global
 * freely, so any unit test importing them has to install a stub first.
 *
 * `LOGGER` is only ever dereferenced inside function bodies, so the stub can be
 * installed from a `beforeAll`/`beforeEach` hook.
 */
export function installLoggerStub() {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    silent: vi.fn(),
    child: vi.fn(() => logger),
  };

  vi.stubGlobal("LOGGER", logger);

  return logger;
}
