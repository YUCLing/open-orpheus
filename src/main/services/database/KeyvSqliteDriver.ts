import type { Database } from "@open-orpheus/database";

import { SqliteDriver } from "@keyv/sqlite";

function coerceParams(params: unknown[]): unknown[] {
  return params.map((p) =>
    p !== null && typeof p === "object" ? JSON.stringify(p) : p
  );
}

export type DatabaseSqliteDriver = SqliteDriver & {
  db: Database;
};

export default function createKeyvSqliteDriver(
  db: Database
): DatabaseSqliteDriver {
  const driver: DatabaseSqliteDriver = {
    name: "custom",
    db,
    async connect(): ReturnType<SqliteDriver["connect"]> {
      return {
        async query(sql, ...params) {
          const p = coerceParams(params);
          const normalized = sql.trimStart().toUpperCase();
          if (
            normalized.startsWith("SELECT") ||
            normalized.startsWith("PRAGMA") ||
            /\bRETURNING\b/.test(normalized)
          ) {
            return (await db.exec(sql, p))[1];
          }
          await db.exec(sql, p);
          return [];
        },
        async close() {},
      };
    },
  };
  return driver;
}
