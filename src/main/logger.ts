import {
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  statSync,
  renameSync,
  createReadStream,
  createWriteStream,
} from "node:fs";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import { ipcMain } from "electron";
import pino, { LogFn } from "pino";

import { log as logDir } from "./platform/folders";

/**
 * Render a Date as a Windows-safe, human-readable filename timestamp (UTC).
 *
 * ISO 8601 strings such as `2026-08-09T12:34:56.789Z` cannot be used in
 * Windows filenames because `:` is not an allowed character, so we format
 * the time as `2026-08-09_12-34-56-789` instead. The fixed-width layout
 * also sorts lexicographically in chronological order.
 */
function formatLogTimestamp(date: Date): string {
  const pad = (value: number, width: number) =>
    value.toString().padStart(width, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}` +
    `_${pad(date.getUTCHours(), 2)}-${pad(date.getUTCMinutes(), 2)}-${pad(date.getUTCSeconds(), 2)}` +
    `-${pad(date.getUTCMilliseconds(), 3)}`
  );
}

/**
 * Inverse of {@link formatLogTimestamp}: parse a log timestamp (without the
 * `.ndjson.gz` extension) back into a Date. Returns `null` if the value is
 * not a valid log timestamp (e.g. a legacy `*.ndjson.gz` file).
 *
 * Accepts the optional numeric de-duplication suffix (`-1`, `-2`, ...) that
 * {@link nextArchiveName} appends for same-millisecond collisions, so
 * conflict archives are still sorted by their actual archive time instead of
 * being treated as unknown (oldest).
 */
function parseLogTimestamp(value: string): Date | null {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{3})(?:-\d+)?$/
  );
  if (!match) return null;
  const [, year, month, day, hours, minutes, seconds, ms] = match.map(Number);
  return new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds, ms));
}

const latestLog = resolve(logDir, "latest.ndjson");

/**
 * Make sure the log directory exists before any of the roll/retention logic
 * below (or the pino transport) touches it.
 *
 * Everything else in this module that reads the directory runs synchronously
 * at import time — earlier than the pino transport worker, which is the only
 * other thing that could create the directory. On a fresh install
 * `readdirSync` would therefore throw `ENOENT` and silently skip recovery and
 * retention for that whole session.
 *
 * This is best-effort on purpose: logging is diagnostic, not a prerequisite
 * for running, so an unwritable location (read-only home, full disk, directory
 * owned by another user, ...) must never stop the app from starting. On
 * failure the roll and retention work below degrades to logging errors, and
 * the pino transport reports its own failure through the error listener.
 */
try {
  mkdirSync(logDir, { recursive: true });
} catch (err) {
  console.error(`Failed to create log directory ${logDir}:`, err);
}

/**
 * Pick the timestamped archive name (appending a `-1`, `-2`, ... suffix if the
 * name is already taken) so no existing archive or pending `.rolling` staging
 * file is ever clobbered. The returned name does not include the `.rolling`
 * staging suffix.
 */
function nextArchiveName(timestamp: Date): string {
  const base = formatLogTimestamp(timestamp);
  let candidate = `${base}.ndjson.gz`;
  for (let i = 1; isArchiveNameTaken(candidate); i++) {
    candidate = `${base}-${i}.ndjson.gz`;
  }
  return candidate;
}

/**
 * Whether an archive name is already in use — either as a finished archive or
 * as a pending `.rolling` staging file left behind by an interrupted roll.
 * Both paths must be reserved so a startup rotation never renames the active
 * log over a not-yet-recovered staging file.
 */
function isArchiveNameTaken(archiveName: string): boolean {
  return (
    existsSync(resolve(logDir, archiveName)) ||
    existsSync(resolve(logDir, `${archiveName}.rolling`))
  );
}

/**
 * Stream-compress a `.ndjson.gz.rolling` staging file into its final
 * `.ndjson.gz` archive, then remove the staging file.
 *
 * Each roll is staged under its final archive name plus a `.rolling` suffix,
 * so the target name is fixed at rename time and an interruption leaves only
 * that specific staging file behind for a future run to finish.
 *
 * The archive is written to a temporary `.tmp` file and atomically renamed
 * into place only after compression succeeds, so a failed compression never
 * leaves a partial `.ndjson.gz` that would occupy a retention slot.
 */
async function finishRoll(rollingName: string): Promise<void> {
  const target = resolve(logDir, rollingName.replace(/\.rolling$/, ""));
  const temp = `${target}.tmp`;
  try {
    await pipeline(
      createReadStream(resolve(logDir, rollingName)),
      createGzip(),
      createWriteStream(temp)
    );
    // A pre-existing target is a stale leftover (e.g. a legacy partial archive
    // left next to its source, or a duplicate from a run interrupted between
    // rename and unlink). The freshly compressed temp is authoritative, so
    // replace it — on Windows, rename cannot overwrite an existing file.
    if (existsSync(target)) unlinkSync(target);
    renameSync(temp, target);
    unlinkSync(resolve(logDir, rollingName));
  } catch (err) {
    // Remove the failed temporary output; it must not occupy a retention slot.
    if (existsSync(temp)) unlinkSync(temp);
    throw err;
  }
}

/**
 * Keep only the 5 most recent rotated logs (legacy filenames go first).
 *
 * Unfinished `.ndjson.gz.rolling` staging files count toward the limit too —
 * they are still valid logs, just not yet compressed. A `.rolling` source and
 * its archive target are the same log, so a collision pair counts once.
 * Pruning runs only after recovery, so by then any remaining staging file has
 * already failed; counting it lets retention clean up failed rolls instead of
 * leaving them forever.
 */
function pruneRotatedLogs(): void {
  // Remove temporary outputs left behind by an interrupted compression; they
  // are never valid archives and must not occupy retention capacity.
  for (const name of readdirSync(logDir).filter((v) =>
    v.endsWith(".ndjson.gz.tmp")
  )) {
    unlinkSync(resolve(logDir, name));
  }

  const all = readdirSync(logDir).filter(
    (v) => v.endsWith(".ndjson.gz") || v.endsWith(".ndjson.gz.rolling")
  );
  // A `.rolling` source whose archive target also exists is the same log
  // twice (e.g. a legacy partial archive plus its source); count the pair as
  // one seat so the collision cannot evict a different valid archive.
  const targets = new Set(all.filter((v) => v.endsWith(".ndjson.gz")));
  const entries = all.filter(
    (v) =>
      !v.endsWith(".ndjson.gz.rolling") ||
      !targets.has(v.replace(/\.rolling$/, ""))
  );
  if (entries.length > 5) {
    const timestamp = (name: string) =>
      parseLogTimestamp(
        name.replace(/\.rolling$/, "").replace(/\.ndjson\.gz$/, "")
      )?.getTime() ?? Number.NEGATIVE_INFINITY;
    entries.sort((a, b) => timestamp(a) - timestamp(b));
    for (const stale of entries.slice(0, entries.length - 5)) {
      unlinkSync(resolve(logDir, stale));
    }
  }
}

/**
 * Roll the active `latest.ndjson` out of the way BEFORE the pino file
 * transport opens it. Doing the rename synchronously here guarantees pino
 * always writes to a brand-new file and never through a handle whose
 * underlying file is later renamed and unlinked by the background roll.
 *
 * Failing to rotate is housekeeping, not a startup error: pino opens the
 * existing file instead, so this run just appends to it.
 */
if (existsSync(latestLog)) {
  try {
    const lastLogStat = statSync(latestLog);
    const rollingName = `${nextArchiveName(lastLogStat.ctime)}.rolling`;
    renameSync(latestLog, resolve(logDir, rollingName));
  } catch (err) {
    console.error("Failed to roll previous log at startup:", err);
  }
}

/**
 * Finish every `.ndjson.gz.rolling` staging file — leftovers from interrupted
 * previous runs and the one rolled above — by streaming each into its final
 * `.ndjson.gz` archive.
 *
 * Finishing runs in the background (started before the transport below, so
 * the two overlap): it only touches `.rolling` files and never the fresh
 * `latest.ndjson` pino is writing to. Each entry is handled independently: a
 * failure leaves that staging file in place for a future run to retry without
 * blocking the rest.
 *
 * Because it always resolves after processing every entry, retention always
 * runs afterwards and can clean up failed staging files via the seat count.
 */
async function finishPendingRolls(): Promise<void> {
  for (const name of readdirSync(logDir).filter((v) =>
    v.endsWith(".ndjson.gz.rolling")
  )) {
    try {
      await finishRoll(name);
    } catch (err) {
      console.error(`Failed to roll ${name}:`, err);
    }
  }
}

void finishPendingRolls()
  .then(pruneRotatedLogs)
  .catch((err) => {
    // finishPendingRolls logs per-entry failures itself; this only guards
    // against unexpected errors, e.g. one raised by pruning.
    console.error("Failed to roll previous log:", err);
  });

const transport: pino.TransportSingleOptions[] = [
  {
    target: "pino/file",
    options: {
      destination: latestLog,
      mkdir: true,
    },
  },
];

if (process.stdout.isTTY)
  transport.push({
    target: "pino-pretty",
    options: {},
  });

const stream = pino.transport({
  targets: transport,
});

stream.addListener("error", (e) => {
  try {
    console.log("Log stream error", e);
  } catch {
    // Hmm, we are lost
  }
});

const logger = pino(stream);

ipcMain.on(
  "logger.log",
  (event, level: string, bindings, ...args: Parameters<LogFn>) => {
    // The preload facade forwards the bindings captured by `child()` (e.g. the
    // `{ name }` injected by the compile-time plugin), so we log through a pino
    // child logger carrying those fields.
    const target =
      bindings && typeof bindings === "object"
        ? logger.child(bindings as Record<string, unknown>)
        : logger;
    (target as unknown as Record<string, LogFn>)[level]?.(...args);
  }
);

export default logger;

declare global {
  /**
   * Global logger instance provided by compile-time injection.
   *
   * It can automatically infer the code context and injects corresponding context information
   * into the log message.
   */
  const LOGGER: typeof logger;
}
