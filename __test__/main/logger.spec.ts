import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "pino";

/**
 * One entry of the transport target list: which pino target the module chose,
 * at which level, and with which options.
 */
type TransportTarget = {
  target: string;
  level?: string;
  options?: Record<string, unknown>;
};

const hoisted = vi.hoisted(() => ({
  transportTargets: [] as TransportTarget[],
  loggerOptions: [] as Array<{ level?: string }>,
  flushSync: vi.fn(),
  log: vi.fn(),
}));

// `pino.transport` normally forks a worker thread, and `pino-pretty` would load
// a real transport; neither belongs in a unit test. Recording the target list
// is the point of these tests.
vi.mock("pino", () => {
  const logger = {
    trace: hoisted.log,
    debug: hoisted.log,
    info: hoisted.log,
    warn: hoisted.log,
    error: hoisted.log,
    fatal: hoisted.log,
    silent: hoisted.log,
    child: vi.fn(() => logger),
  } as unknown as Logger;

  const pino = vi.fn((options: { level?: string }) => {
    hoisted.loggerOptions.push(options);
    return logger;
  });

  return {
    default: Object.assign(pino, {
      transport: vi.fn((options: { targets: TransportTarget[] }) => {
        hoisted.transportTargets.push(...options.targets);
        return { flushSync: hoisted.flushSync, addListener: vi.fn() };
      }),
    }),
  };
});

vi.mock("electron", () => ({ ipcMain: { on: vi.fn() } }));

// `logger.ts` rolls, compresses and prunes real files at import time, so each
// import gets a throwaway log directory instead of the app's own.
let logDir = "";

vi.mock("../../src/main/folders", () => ({
  get log() {
    return logDir;
  },
}));

// `isTTY` is inherited from the stream prototype rather than owned by
// `process.stdout`, so it has to be shadowed with an own property — and the
// shadow removed again — instead of being assigned.
const originalIsTty = process.stdout.isTTY;

function setStdoutIsTty(value: boolean | undefined): void {
  if (value === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
  else Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
}

const LOG_ENV_VARS = [
  "OPEN_ORPHEUS_LOG_LEVEL",
  "OPEN_ORPHEUS_LOG_LEVEL_CONSOLE",
  "OPEN_ORPHEUS_LOG_LEVEL_FILE",
  "OPEN_ORPHEUS_LOG_FORMAT",
] as const;

function clearLoggerEnv(): void {
  for (const name of LOG_ENV_VARS) delete process.env[name];
  // Removed in favor of OPEN_ORPHEUS_LOG_FORMAT; make sure a stray value in
  // the environment cannot affect the tests.
  delete process.env.OPEN_ORPHEUS_FORCE_PRETTY;
}

/**
 * Point the module at a fresh log directory and import it, returning the
 * targets it handed to `pino.transport` and the options it handed to pino.
 */
async function importLogger(): Promise<{
  targets: TransportTarget[];
  options: { level?: string } | undefined;
}> {
  hoisted.transportTargets.length = 0;
  hoisted.loggerOptions.length = 0;
  hoisted.log.mockClear();
  // Each import must start from a clean module registry: the target list is
  // built once, at import time.
  vi.resetModules();
  await import("../../src/main/logger");
  return {
    targets: [...hoisted.transportTargets],
    options: hoisted.loggerOptions.at(-1),
  };
}

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), "open-orpheus-logger-"));
  setStdoutIsTty(undefined);
  clearLoggerEnv();
});

afterEach(() => {
  setStdoutIsTty(originalIsTty);
  clearLoggerEnv();
  rmSync(logDir, { recursive: true, force: true });
});

describe("log transport", () => {
  it("writes JSON to the file and stdout by default", async () => {
    const { targets, options } = await importLogger();

    expect(options).toEqual({ level: "info" });
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({
      target: "pino/file",
      level: "info",
      options: {
        destination: join(logDir, "latest.ndjson"),
        mkdir: true,
      },
    });
    expect(targets[1]).toEqual({
      target: "pino/file",
      level: "info",
      options: { destination: 1 },
    });
  });

  it("prettifies when stdout is a TTY", async () => {
    setStdoutIsTty(true);

    const { targets } = await importLogger();

    expect(targets).toHaveLength(2);
    expect(targets[1]).toMatchObject({
      target: "pino-pretty",
      level: "info",
      options: {},
    });
    // Pretty output goes to stdout implicitly, so the module must not also
    // open stdout as a raw file destination.
    expect(targets.some((t) => t.options?.destination === 1)).toBe(false);
  });

  it("prettifies when OPEN_ORPHEUS_LOG_FORMAT=pretty", async () => {
    process.env.OPEN_ORPHEUS_LOG_FORMAT = "pretty";

    const { targets } = await importLogger();

    expect(targets[1].target).toBe("pino-pretty");
  });

  it("forces JSON when OPEN_ORPHEUS_LOG_FORMAT=json even on a TTY", async () => {
    setStdoutIsTty(true);
    process.env.OPEN_ORPHEUS_LOG_FORMAT = "json";

    const { targets } = await importLogger();

    expect(targets[1]).toEqual({
      target: "pino/file",
      level: "info",
      options: { destination: 1 },
    });
  });

  it("ignores invalid formats and warns", async () => {
    process.env.OPEN_ORPHEUS_LOG_FORMAT = "yaml";

    const { targets } = await importLogger();

    expect(targets[1].target).toBe("pino/file");
    expect(hoisted.log).toHaveBeenCalledWith(
      {
        variable: "OPEN_ORPHEUS_LOG_FORMAT",
        value: "yaml",
        fallback: "auto",
      },
      "Invalid logger configuration value"
    );
  });

  it("ignores the removed OPEN_ORPHEUS_FORCE_PRETTY variable", async () => {
    process.env.OPEN_ORPHEUS_FORCE_PRETTY = "1";

    const { targets } = await importLogger();

    expect(targets[1]).toEqual({
      target: "pino/file",
      level: "info",
      options: { destination: 1 },
    });
  });
});

describe("log levels", () => {
  it("applies OPEN_ORPHEUS_LOG_LEVEL to every sink", async () => {
    process.env.OPEN_ORPHEUS_LOG_LEVEL = "debug";

    const { targets, options } = await importLogger();

    expect(options).toEqual({ level: "debug" });
    expect(targets.map((target) => target.level)).toEqual(["debug", "debug"]);
  });

  it("lets the console and file levels override the global default", async () => {
    process.env.OPEN_ORPHEUS_LOG_LEVEL = "info";
    process.env.OPEN_ORPHEUS_LOG_LEVEL_CONSOLE = "warn";
    process.env.OPEN_ORPHEUS_LOG_LEVEL_FILE = "debug";

    const { targets, options } = await importLogger();

    // The base logger must allow the most verbose sink, then each target
    // filters its own records.
    expect(options).toEqual({ level: "debug" });
    expect(targets[0]).toMatchObject({ target: "pino/file", level: "debug" });
    expect(targets[1]).toMatchObject({ target: "pino/file", level: "warn" });
  });

  it("allows a sink level to re-enable a globally silent sink", async () => {
    process.env.OPEN_ORPHEUS_LOG_LEVEL = "silent";
    process.env.OPEN_ORPHEUS_LOG_LEVEL_FILE = "debug";

    const { targets, options } = await importLogger();

    expect(options).toEqual({ level: "debug" });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ target: "pino/file", level: "debug" });
  });

  it("disables the console sink with a silent console level", async () => {
    process.env.OPEN_ORPHEUS_LOG_LEVEL = "debug";
    process.env.OPEN_ORPHEUS_LOG_LEVEL_CONSOLE = "silent";

    const { targets, options } = await importLogger();

    expect(options).toEqual({ level: "debug" });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ target: "pino/file", level: "debug" });
  });

  it("disables the file sink with a silent file level", async () => {
    process.env.OPEN_ORPHEUS_LOG_LEVEL = "debug";
    process.env.OPEN_ORPHEUS_LOG_LEVEL_FILE = "silent";

    const { targets, options } = await importLogger();

    expect(options).toEqual({ level: "debug" });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toEqual({
      target: "pino/file",
      level: "debug",
      options: { destination: 1 },
    });
  });

  it("disables all sinks when every level is silent", async () => {
    process.env.OPEN_ORPHEUS_LOG_LEVEL = "silent";

    const { targets, options } = await importLogger();

    expect(options).toEqual({ level: "silent" });
    expect(targets).toHaveLength(0);
  });

  it("falls back to info and warns for an invalid global level", async () => {
    process.env.OPEN_ORPHEUS_LOG_LEVEL = "verbose";

    const { targets, options } = await importLogger();

    expect(options).toEqual({ level: "info" });
    expect(targets.map((target) => target.level)).toEqual(["info", "info"]);
    expect(hoisted.log).toHaveBeenCalledWith(
      {
        variable: "OPEN_ORPHEUS_LOG_LEVEL",
        value: "verbose",
        fallback: "info",
      },
      "Invalid logger configuration value"
    );
  });

  it("falls back to the global level for an invalid sink level", async () => {
    process.env.OPEN_ORPHEUS_LOG_LEVEL = "debug";
    process.env.OPEN_ORPHEUS_LOG_LEVEL_CONSOLE = "loud";

    const { targets, options } = await importLogger();

    expect(options).toEqual({ level: "debug" });
    expect(targets.map((target) => target.level)).toEqual(["debug", "debug"]);
    expect(hoisted.log).toHaveBeenCalledWith(
      {
        variable: "OPEN_ORPHEUS_LOG_LEVEL_CONSOLE",
        value: "loud",
        fallback: "debug",
      },
      "Invalid logger configuration value"
    );
  });
});
