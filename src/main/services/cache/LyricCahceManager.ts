import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, resolve } from "node:path";

type LyricCacheEntry = {
  mtime: number;
  size: number;
  content?: string;
};

export default class LyricCacheManager {
  private readonly entries = new Map<string, LyricCacheEntry>();
  private totalSizeBytes = 0;
  private readonly initPromise: Promise<void>;
  private evictionPromise: Promise<void> | null = null;

  constructor(
    private readonly cacheDir: string,
    private readonly maxSizeBytes: number = 20 * 1024 * 1024
  ) {
    this.initPromise = this.buildEntriesIndex();
  }

  private async buildEntriesIndex(): Promise<void> {
    try {
      await mkdir(this.cacheDir, { recursive: true });
      const names = await readdir(this.cacheDir);
      const stats = await Promise.all(
        names.map(async (name) => {
          try {
            const filePath = resolve(this.cacheDir, name);
            const fileStats = await stat(filePath);
            if (!fileStats.isFile()) return null;
            return { name, mtime: fileStats.mtimeMs, size: fileStats.size };
          } catch {
            return null;
          }
        })
      );

      for (const entry of stats) {
        if (!entry) continue;
        this.entries.set(entry.name, { mtime: entry.mtime, size: entry.size });
        this.totalSizeBytes += entry.size;
      }
    } catch {
      // Directory may not exist yet.
    }
  }

  private async ready(): Promise<void> {
    await this.initPromise;
  }

  private getEntryKey(songId: string): string {
    const key = `${songId}`;
    if (basename(key) !== key) {
      throw new Error(`Invalid lyric cache key: ${songId}`);
    }
    return key;
  }

  private resolveEntryPath(key: string): string {
    return resolve(this.cacheDir, key);
  }

  async get(songId: string): Promise<string | null> {
    await this.ready();

    const key = this.getEntryKey(songId);
    const cached = this.entries.get(key);
    if (cached?.content !== undefined) {
      cached.mtime = Date.now();
      return cached.content;
    }

    try {
      const content = await readFile(this.resolveEntryPath(key), "utf-8");
      const size = Buffer.byteLength(content);
      if (cached) {
        this.totalSizeBytes += size - cached.size;
        cached.size = size;
        cached.mtime = Date.now();
        cached.content = content;
      } else {
        this.entries.set(key, { mtime: Date.now(), size, content });
        this.totalSizeBytes += size;
      }
      return content;
    } catch {
      if (cached) {
        this.totalSizeBytes -= cached.size;
        this.entries.delete(key);
      }
      return null;
    }
  }

  async set(songId: string, content: string): Promise<void> {
    await this.ready();
    await mkdir(this.cacheDir, { recursive: true });

    const key = this.getEntryKey(songId);
    const size = Buffer.byteLength(content);
    const existing = this.entries.get(key);
    await writeFile(this.resolveEntryPath(key), content, { flag: "w" });

    if (existing) {
      this.totalSizeBytes -= existing.size;
    }

    this.entries.set(key, {
      mtime: Date.now(),
      size,
      content,
    });
    this.totalSizeBytes += size;
    await this.evictIfNeeded();
  }

  async getStats(): Promise<{ entryCount: number; sizeBytes: number }> {
    await this.ready();
    return {
      entryCount: this.entries.size,
      sizeBytes: this.totalSizeBytes,
    };
  }

  async clear(): Promise<void> {
    await this.ready();
    try {
      await rm(this.cacheDir, { recursive: true, force: true });
    } catch {
      // Already gone.
    }
    this.entries.clear();
    this.totalSizeBytes = 0;
  }

  private async evictIfNeeded(): Promise<void> {
    if (this.totalSizeBytes <= this.maxSizeBytes) return;
    if (this.evictionPromise) return this.evictionPromise;

    this.evictionPromise = (async () => {
      while (this.totalSizeBytes > this.maxSizeBytes) {
        const sortedEntries = [...this.entries.entries()]
          .map(([name, { mtime, size }]) => ({ name, mtime, size }))
          .sort((a, b) => a.mtime - b.mtime);

        const excessBytes = this.totalSizeBytes - this.maxSizeBytes;
        let toFreeBytes = 0;
        const toDelete: typeof sortedEntries = [];
        for (const entry of sortedEntries) {
          toDelete.push(entry);
          toFreeBytes += entry.size;
          if (toFreeBytes >= excessBytes) break;
        }

        let anyDeleted = false;
        await Promise.all(
          toDelete.map(({ name, size }) =>
            unlink(this.resolveEntryPath(name))
              .then(() => {
                this.entries.delete(name);
                this.totalSizeBytes -= size;
                anyDeleted = true;
              })
              .catch(() => {
                // Deletion failed — leave entry tracked for next pass.
              })
          )
        );

        if (!anyDeleted) break;
      }
    })().finally(() => {
      this.evictionPromise = null;
    });

    return this.evictionPromise;
  }
}
