import {
  existsSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
  statSync,
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

import pino from "pino";

import { log as logDir } from "./folders";

const latestLog = resolve(logDir, "latest.ndjson");

if (existsSync(latestLog)) {
  // Roll the log
  const lastLogStat = statSync(latestLog);
  const lastLog = readFileSync(latestLog);
  const gzipped = gzipSync(lastLog);
  writeFileSync(
    resolve(logDir, `${lastLogStat.ctime.toISOString()}.ndjson.gz`),
    gzipped
  );
  unlinkSync(latestLog);

  const entries = readdirSync(logDir).filter((v) => v.endsWith(".ndjson.gz"));
  if (entries.length > 5) {
    // Keep only up to 5 old log entries
    const oldest = entries.sort()[0];
    unlinkSync(resolve(logDir, oldest));
  }
}

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

const logger = pino(
  pino.transport({
    targets: transport,
  })
);

export default logger;
