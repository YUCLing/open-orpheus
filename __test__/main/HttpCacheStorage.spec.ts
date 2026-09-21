import { beforeEach, describe, expect, it, vi } from "vitest";

// memfs-backed, see `__mocks__/fs/promises.cts`.
vi.mock("node:fs/promises");
vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  screen: { getDisplayMatching: vi.fn() },
}));

import { vol } from "memfs";

import HttpCacheStorage from "@main/cache/HttpCacheStorage";
import { installLoggerStub } from "../helpers/globals";

const LAST_VACUUM_KEY = "httpCache::lastVacuum";
const DB_PATH = "/data/cache.sqlite";

type FakeDriver = ReturnType<typeof createDriver>;

/** Minimal stand-in for the Keyv sqlite driver. */
function createDriver() {
  const store = new Map<string, unknown>();
  return {
    store,
    on: vi.fn(),
    get: vi.fn(async (key: string) => store.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
      return true;
    }),
    delete: vi.fn(async (key: string) => store.delete(key)),
    // Keyv v6 only accepts an adapter whose get/set/delete/clear are async.
    clear: vi.fn(async () => {
      store.clear();
    }),
    // Typed so `mock.calls` keeps the SQL argument, even though the stub
    // implementation ignores it.
    query: vi.fn<(sql: string) => Promise<unknown[]>>(async () => []),
    table: "cache",
    driver: { db: { filePath: DB_PATH } },
  };
}

function newStorage(driver: FakeDriver) {
  return new HttpCacheStorage(driver as never);
}

/** Read the stored vacuum timestamp through the public Keyv API. */
async function timestampOf(storage: HttpCacheStorage) {
  return (await storage.get(LAST_VACUUM_KEY)) as number | undefined;
}

const STALE_AFTER_MS = 49 * 60 * 60 * 1000;

/** Let a constructor's fire-and-forget vacuum settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  vol.reset();
  installLoggerStub();
});

describe("HttpCacheStorage automatic vacuum", () => {
  it("records the first vacuum timestamp", async () => {
    const driver = createDriver();
    const storage = newStorage(driver);

    await vi.waitFor(async () => {
      expect(await timestampOf(storage)).toEqual(expect.any(Number));
    });
    expect(await timestampOf(storage)).toBeLessThanOrEqual(Date.now());
    expect(driver.query).not.toHaveBeenCalled();
  });

  it("skips the vacuum while the last one is recent", async () => {
    const driver = createDriver();
    const first = newStorage(driver);
    await vi.waitFor(async () => {
      expect(await timestampOf(first)).toEqual(expect.any(Number));
    });
    const recorded = await timestampOf(first);
    driver.query.mockClear();

    newStorage(driver);
    await settle();

    expect(driver.query).not.toHaveBeenCalled();
    // The second instance left the existing timestamp alone.
    expect(await timestampOf(first)).toBe(recorded);
  });

  it("vacuums once the last run is older than two days", async () => {
    const driver = createDriver();
    const first = newStorage(driver);
    // Wait for the constructor's own write, otherwise it would land after ours.
    await vi.waitFor(async () => {
      expect(await timestampOf(first)).toEqual(expect.any(Number));
    });
    const stale = Date.now() - STALE_AFTER_MS;
    await first.set(LAST_VACUUM_KEY, stale);
    driver.query.mockClear();

    newStorage(driver);

    await vi.waitFor(() => {
      expect(driver.query).toHaveBeenCalledWith("VACUUM;");
    });
    expect(driver.query).toHaveBeenCalledWith(
      "PRAGMA wal_checkpoint(TRUNCATE);"
    );
    expect(await timestampOf(first)).toBeGreaterThan(stale);
  });

  it("logs a failed automatic vacuum instead of crashing", async () => {
    const logger = installLoggerStub();
    const driver = createDriver();
    const first = newStorage(driver);
    await vi.waitFor(async () => {
      expect(await timestampOf(first)).toEqual(expect.any(Number));
    });
    await first.set(LAST_VACUUM_KEY, Date.now() - STALE_AFTER_MS);
    driver.query.mockRejectedValue(new Error("database is locked"));

    expect(() => newStorage(driver)).not.toThrow();

    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalled();
    });
  });
});

describe("HttpCacheStorage.vacuum", () => {
  it("checkpoints, vacuums and stamps the timestamp", async () => {
    const driver = createDriver();
    const storage = newStorage(driver);
    const stale = Date.now() - STALE_AFTER_MS;
    await storage.set(LAST_VACUUM_KEY, stale);
    driver.query.mockClear();

    await storage.vacuum();

    expect(driver.query.mock.calls.map(([sql]) => sql)).toEqual([
      "VACUUM;",
      "PRAGMA wal_checkpoint(TRUNCATE);",
    ]);
    expect(await timestampOf(storage)).toBeGreaterThan(stale);
  });
});

describe("HttpCacheStorage stats", () => {
  it("reports the valid page bytes as totalSize", async () => {
    const driver = createDriver();
    driver.query.mockResolvedValue([{ valid_bytes: 4096 }]);

    await expect(newStorage(driver).totalSize()).resolves.toBe(4096);
    expect(driver.query.mock.calls[0][0]).toContain("pragma_page_count()");
  });

  it("counts entries", async () => {
    const driver = createDriver();
    driver.query.mockResolvedValue([{ count: 42 }]);

    await expect(newStorage(driver).entryCount()).resolves.toBe(42);
  });

  it("reports -1 when the count query fails", async () => {
    const driver = createDriver();
    driver.query.mockRejectedValue(new Error("no such table"));

    await expect(newStorage(driver).entryCount()).resolves.toBe(-1);
  });

  it("sums the database, WAL and SHM files for diskSize", async () => {
    vol.mkdirSync("/data", { recursive: true });
    vol.writeFileSync(DB_PATH, Buffer.alloc(10));
    vol.writeFileSync(`${DB_PATH}-wal`, Buffer.alloc(20));
    vol.writeFileSync(`${DB_PATH}-shm`, Buffer.alloc(30));

    await expect(newStorage(createDriver()).diskSize()).resolves.toBe(60);
  });

  it("ignores missing sidecar files", async () => {
    vol.mkdirSync("/data", { recursive: true });
    vol.writeFileSync(DB_PATH, Buffer.alloc(7));

    await expect(newStorage(createDriver()).diskSize()).resolves.toBe(7);
  });
});
