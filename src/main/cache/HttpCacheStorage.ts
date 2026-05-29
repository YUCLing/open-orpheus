import { KeyvSqlite } from "@keyv/sqlite";
import { Keyv } from "keyv";
import { calculateDbSize } from "../util";

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
    })();
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
    return await calculateDbSize(this.driver.db);
  }

  async entryCount() {
    let entryCount = -1;

    const iter = this.iterator?.(undefined);
    if (iter) {
      entryCount = 0;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const v of iter) {
        entryCount++;
      }
    }

    return entryCount;
  }
}
