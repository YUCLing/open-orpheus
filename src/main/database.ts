import { join } from "node:path";

import Database from "better-sqlite3";

const pathToWebDb = join("data", "webdb.dat");
const pathToMusicLibrary = join("data", "library.dat");

export const webDb = new Database(pathToWebDb);
export const musicLibraryDb = new Database(pathToMusicLibrary);

// NEED WORK!!

function rowToStringMap(row: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, v == null ? "" : String(v)])
  );
}

export function storageExecsql(
  db: Database.Database,
  requestId: string,
  sql: string
) {
  const t0 = performance.now();

  let errCode = 0;
  let rows: unknown[] | undefined = undefined;
  let rowsAffected = 0;

  const t1 = performance.now();

  try {
    const rawRows = db.prepare(sql).all() as Record<string, unknown>[];
    if (rawRows.length > 0) {
      rows = rawRows.map(rowToStringMap);
    }

    rowsAffected =
      (db.prepare("SELECT changes()").get() as { "changes()"?: number })?.[
        "changes()"
      ] ?? 0;
  } catch (err) {
    if (err.message.includes("more than one statement")) {
      db.exec(sql);
    } else {
      errCode = err.code ?? 1;
      console.error(`execsql fail: ${err.message}`);
    }
  }

  const t2 = performance.now();

  return {
    requestId,
    errCode,
    rows,
    perf: [
      Math.max(1, Math.round(t2 - t0)),
      Math.max(1, Math.round(t1 - t0)),
      rowsAffected,
    ],
  };
}

export function musicLibraryExecsql(
  db: Database.Database,
  requestId: string,
  sqlArray: string[],
  callback: (results: {
    error: number;
    id: string;
    reason: string;
    result: boolean;
    value?: unknown[];
  }) => void
): boolean {
  for (let i = 0; i < sqlArray.length; i++) {
    if (typeof sqlArray[i] !== "string") {
      console.error(`Param Type error: ${typeof sqlArray[i]} at index ${i}`);
      return false;
    }
  }

  setImmediate(() => {
    let error = 0;
    let reason = "";
    let value: unknown[] | undefined = undefined;

    const txn = db.transaction((statements: string[]) => {
      for (const sql of statements) {
        try {
          const rawRows = db.prepare(sql).all() as Record<string, unknown>[];
          if (rawRows.length > 0) {
            value = rawRows.map((row) =>
              Object.values(row).map((v) => (v == null ? "" : String(v)))
            );
          }
        } catch (err) {
          if (err.message.includes("more than one statement")) {
            db.exec(sql);
          } else {
            throw err;
          }
        }
      }
    });

    try {
      txn(sqlArray);
    } catch (err) {
      error = err.code ?? 1;
      reason = err.message ?? "unknown error";
      value = undefined;
    }

    callback({
      error,
      id: requestId,
      reason,
      result: error === 0,
      value,
    });
  });

  return true;
}
