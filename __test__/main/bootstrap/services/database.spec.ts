import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/open-orpheus-test", isPackaged: false },
}));

import type { Database } from "@open-orpheus/database";

import { createDatabaseService } from "@main/bootstrap/services/database";

function fakeDatabase() {
  return {
    executeSql: vi.fn<(sql: string) => Promise<unknown>>(),
    executeSqls: vi.fn<(sqls: string[]) => Promise<unknown>>(),
    exec: vi.fn<(sql: string, params: unknown[]) => Promise<unknown>>(),
  };
}

async function createService() {
  const opened: { path: string; db: ReturnType<typeof fakeDatabase> }[] = [];
  const service = await createDatabaseService({
    openDatabase: (path) => {
      const db = fakeDatabase();
      opened.push({ path, db });
      return db as unknown as Database;
    },
  });
  return { service, opened };
}

describe("createDatabaseService", () => {
  it("opens one database per store", async () => {
    const { opened } = await createService();

    expect(opened.map(({ path }) => path.split("/").pop())).toEqual([
      "webdb.dat",
      "library.dat",
      "openorpheus.db",
    ]);
  });

  it("creates the track table and its indexes on the music library only", async () => {
    const { opened } = await createService();
    const [web, library] = opened;

    const schema = library.db.executeSql.mock.calls;
    expect(schema).toHaveLength(1);
    expect(schema[0][0]).toContain("CREATE TABLE IF NOT EXISTS track");
    expect(schema[0][0]).toContain("file TEXT");

    const indexes = library.db.executeSqls.mock.calls;
    expect(indexes).toHaveLength(1);
    expect(indexes[0][0]).toHaveLength(4);
    expect(indexes[0][0].every((sql) => sql.includes("ON track"))).toBe(true);

    expect(web.db.executeSql).not.toHaveBeenCalled();
    expect(web.db.executeSqls).not.toHaveBeenCalled();
    expect(web.db.exec).not.toHaveBeenCalled();
  });

  it("puts the native database in WAL mode with full synchronous writes", async () => {
    const { opened } = await createService();

    expect(opened[2].db.exec.mock.calls).toEqual([
      ["PRAGMA journal_mode = WAL;", []],
      ["PRAGMA synchronous = FULL;", []],
    ]);
  });

  it("exposes the opened databases on the service", async () => {
    const { service, opened } = await createService();

    expect(service.webDb).toBe(opened[0].db);
    expect(service.musicLibraryDb).toBe(opened[1].db);
    expect(service.nativeDb).toBe(opened[2].db);
  });
});
