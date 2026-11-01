import { vi } from "vitest";

/**
 * Install the compile-time-injected `LOGGER` global for every test file.
 *
 * Production code gets `LOGGER` from `plugins/LoggerPlugin.ts`, but Vitest runs
 * the untransformed sources, so the global does not exist unless a spec stubs
 * it. Installing it once here keeps specs that exercise a logging code path
 * (including the preload bridge helpers) from throwing `ReferenceError: LOGGER
 * is not defined`, without every spec having to remember the stub. Specs that
 * assert on specific log calls still install their own stub with
 * `installLoggerStub()`, which replaces this one.
 *
 * The global is assigned directly instead of with `vi.stubGlobal`, so a spec's
 * `vi.unstubAllGlobals()` (used by e.g. arguments/calls specs) cannot remove
 * the logger while modules under test still reference it.
 */
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

Object.defineProperty(globalThis, "LOGGER", {
  value: logger,
  configurable: true,
  writable: true,
});
