import { KeyvSqlite } from "@keyv/sqlite";
import { Keyv } from "keyv";

import { calculateDbSize } from "../platform/util";
import type { DatabaseSqliteDriver } from "../database/KeyvSqliteDriver";
import { toError } from "@shared/util";

export default class HttpCacheStorage extends Keyv {
  private driver: KeyvSqlite;

  constructor(driver: KeyvSqlite) {
    super(driver);

    this.driver = driver;

    (async () => {
      const lastVacuum = await this.get("httpCache::lastVacuum");
      const now = Date.now();
      if (typeof lastVacuum !== "number") {
        await this.set("httpCache::lastVacuum", now);
        return;
      }
      // 2 days
      if (now - lastVacuum <= 48 * 60 * 60 * 1000) return;
      await this.vacuum();
    })().catch((e) => {
      LOGGER.error({ err: toError(e) }, "Failed to run auto vaccum");
    });
  }

  async vacuum() {
    await this.driver.query("VACUUM;");
    await this.driver.query("PRAGMA wal_checkpoint(TRUNCATE);");
    await this.set("httpCache::lastVacuum", Date.now());
  }

  async totalSize() {
    const result = await this.driver
      .query(`SELECT (page_count - freelist_count) * page_size AS valid_bytes
FROM pragma_page_count(), pragma_freelist_count(), pragma_page_size();`);
    return (result[0] as { valid_bytes: number }).valid_bytes;
  }

  async diskSize() {
    // We now always use our own driver
    return await calculateDbSize(
      (this.driver.driver as DatabaseSqliteDriver).db.filePath
    );
  }

  async entryCount() {
    try {
      const result = await this.driver.query(
        `SELECT COUNT(*) AS count FROM ${this.driver.table};`
      );
      return (result[0] as { count: number }).count;
    } catch {
      return -1;
    }
  }
}
