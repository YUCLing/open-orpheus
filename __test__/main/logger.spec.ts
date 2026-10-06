import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "pino";

/**
 * One entry of the transport target list: which pino target the module chose
 * and with which options.
 */
type TransportTarget = { target: string; options?: Record<string, unknown> };

const hoisted = vi.hoisted(() => ({
  transportTargets: [] as TransportTarget[],
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

  return {
    default: Object.assign(
      vi.fn(() => logger),
      {
        transport: vi.fn((options: { targets: TransportTarget[] }) => {
          hoisted.transportTargets.push(...options.targets);
          return { flushSync: hoisted.flushSync, addListener: vi.fn() };
        }),
      }
    ),
  };
});

vi.mock("electron", () => ({
  ipcMain: { on: vi.fn() },
  // `platform/folders` resolves its directories from these at import time, so
  // the real module can be used instead of mocking it.
  app: { getPath: vi.fn((name: string) => `/tmp/open-orpheus-test/${name}`) },
}));

// `logger.ts` rolls, compresses and prunes real files at import time, so each
// import gets a throwaway log directory instead of the app's own.
let logDir = "";

// `isTTY` is inherited from the stream prototype rather than owned by
// `process.stdout`, so it has to be shadowed with an own property — and the
// shadow removed again — instead of being assigned.
const originalIsTty = process.stdout.isTTY;

function setStdoutIsTty(value: boolean | undefined): void {
  if (value === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
  else Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
}

/**
 * Point the module at a fresh log directory and import it, returning the
 * targets it handed to `pino.transport`.
 */
async function importLogger(): Promise<TransportTarget[]> {
  hoisted.transportTargets.length = 0;
  // Each import must start from a clean module registry: the target list is
  // built once, at import time.
  vi.resetModules();
  await import("@main/platform/logger");
  return hoisted.transportTargets;
}

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), "open-orpheus-logger-"));
  setStdoutIsTty(undefined);
  delete process.env["OPEN_ORPHEUS_FORCE_PRETTY"];
});

afterEach(() => {
  setStdoutIsTty(originalIsTty);
  delete process.env["OPEN_ORPHEUS_FORCE_PRETTY"];
  rmSync(logDir, { recursive: true, force: true });
});

describe("log transport", () => {
  it("sends output to stdout when stdout is not a TTY", async () => {
    const targets = await importLogger();

    // The rotating file sink is always present; the second target is what
    // decides where the user actually sees the logs.
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({ target: "pino/file" });
    expect(targets[1]).toEqual({ target: "pino/file", options: { destination: 1 } });
  });

  it("prettifies when stdout is a TTY", async () => {
    setStdoutIsTty(true);

    const targets = await importLogger();

    expect(targets).toHaveLength(2);
    expect(targets[1].target).toBe("pino-pretty");
    // Pretty output goes to stdout implicitly, so the module must not also
    // open stdout as a raw file destination.
    expect(targets.some((t) => t.options?.["destination"] === 1)).toBe(false);
  });

  it("prettifies when OPEN_ORPHEUS_FORCE_PRETTY=1", async () => {
    process.env["OPEN_ORPHEUS_FORCE_PRETTY"] = "1";

    const targets = await importLogger();

    expect(targets[1].target).toBe("pino-pretty");
  });

  it("prettifies when OPEN_ORPHEUS_FORCE_PRETTY=true", async () => {
    process.env["OPEN_ORPHEUS_FORCE_PRETTY"] = "true";

    const targets = await importLogger();

    expect(targets[1].target).toBe("pino-pretty");
  });

  it("ignores other OPEN_ORPHEUS_FORCE_PRETTY values", async () => {
    process.env["OPEN_ORPHEUS_FORCE_PRETTY"] = "yes";

    const targets = await importLogger();

    expect(targets[1]).toEqual({ target: "pino/file", options: { destination: 1 } });
  });
});
