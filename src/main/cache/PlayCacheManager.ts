import {
  access,
  mkdir,
  readdir,
  readFile,
  writeFile,
  rm,
  statfs,
} from "node:fs/promises";
import { resolve } from "node:path";

import { mainWindow } from "../window";

// #region Types

export type PlayCacheConfig = {
  ABName: string;
  autoCacheSize: string;
  configJson: string;
  groupName: string;
  manuSetting: unknown;
  settingLowLimit: string;
  settingUpLimit: string;
  userSettingSize: string;
};

export type PlayCacheInfo = {
  ABName: string;
  autoCacheSize: number;
  autoCacheSizeReal: number;
  cachePath: string;
  clearLimitMax: number;
  clearToLimit: number;
  configJson: string;
  currentCachedSize: number;
  diskFreeSize: number;
  groupName: string;
  manuSetting: boolean;
  settingLowLimit: number;
  settingUpLimit: number;
  userSettingSize: number;
  userSettingSizeReal: number;
};

export type CacheTrackMeta = {
  bitrate: number;
  cached: number;
  dfsId: string;
  format: string;
  lastAccessTime: number;
  lastModifyTime: number;
  md5: string;
  playInfoExist: boolean;
  playInfoStr: string;
  songId: string;
  volumeGain: number;
  fileSize: number;
};

// #endregion

// #region PlayCacheManager

export default class PlayCacheManager {
  private config: PlayCacheConfig | null = null;
  /** In-memory index of cached tracks, keyed by songId */
  private trackIndex = new Map<string, CacheTrackMeta>();
  private initPromise: Promise<void>;
  private cachePath: string;

  constructor(cachePath: string) {
    this.cachePath = cachePath;
    this.initPromise = this.buildIndex();
  }

  // #region Initialization

  private async buildIndex(): Promise<void> {
    try {
      await mkdir(this.cachePath, { recursive: true });
      const entries = await readdir(this.cachePath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const metaPath = resolve(this.cachePath, entry.name, "meta.json");
        try {
          const raw = await readFile(metaPath, "utf-8");
          const meta: CacheTrackMeta = JSON.parse(raw);
          this.trackIndex.set(meta.songId, meta);
        } catch {
          // Corrupted or missing meta — skip
        }
      }
    } catch {
      // Directory doesn't exist yet — that's fine
    }
  }

  private async ready(): Promise<void> {
    await this.initPromise;
  }

  // #endregion

  // #region Config

  setConfig(config: PlayCacheConfig): void {
    this.config = config;
  }

  async getInfo(): Promise<PlayCacheInfo> {
    await this.ready();

    const userSettingSize = this.config
      ? Number(this.config.userSettingSize)
      : 10;
    const settingLowLimit = this.config
      ? Number(this.config.settingLowLimit)
      : 10;
    const settingUpLimit = this.config
      ? Number(this.config.settingUpLimit)
      : 50;
    const autoCacheSize = this.config ? Number(this.config.autoCacheSize) : 1;

    const currentCachedSize = await this.getCachedSizeGB();
    const diskFreeSize = await this.getDiskFreeGB();

    return {
      ABName: this.config?.ABName ?? "PH-PC-Cache-Switch",
      autoCacheSize,
      autoCacheSizeReal: autoCacheSize,
      cachePath: this.cachePath,
      clearLimitMax: userSettingSize,
      clearToLimit: Math.floor(userSettingSize * 0.8),
      configJson: this.config?.configJson ?? "",
      currentCachedSize,
      diskFreeSize,
      groupName: this.config?.groupName ?? "t1",
      manuSetting:
        this.config?.manuSetting === true ||
        this.config?.manuSetting === "true",
      settingLowLimit,
      settingUpLimit,
      userSettingSize,
      userSettingSizeReal: userSettingSize,
    };
  }

  // #endregion

  // #region Query

  async queryCacheTracks(): Promise<CacheTrackMeta[]> {
    await this.ready();
    return Array.from(this.trackIndex.values());
  }

  async getCachedTrack(
    songId: string
  ): Promise<{ meta: CacheTrackMeta; audioPath: string } | null> {
    await this.ready();
    const meta = this.trackIndex.get(songId);
    if (!meta) return null;

    const audioPath = resolve(this.cachePath, songId, "audio");
    try {
      await access(audioPath);
    } catch {
      // Audio file missing or unreadable — remove from index
      this.trackIndex.delete(songId);
      return null;
    }

    // Update access time
    meta.lastAccessTime = Math.floor(Date.now() / 1000);
    void this.writeMeta(songId, meta).catch(() => {});

    return { meta, audioPath };
  }

  // #endregion

  // #region Write

  async cacheTrack(
    songId: string,
    audioBuffer: Buffer,
    info: {
      md5: string;
      bitrate: number;
      playInfoStr: string;
      volumeGain: number;
      fileSize: number;
    }
  ): Promise<void> {
    await this.ready();

    const songDir = resolve(this.cachePath, songId);
    await mkdir(songDir, { recursive: true });

    const now = Math.floor(Date.now() / 1000);
    const meta: CacheTrackMeta = {
      bitrate: info.bitrate,
      cached: 100,
      dfsId: "",
      format: "",
      lastAccessTime: now,
      lastModifyTime: now,
      md5: info.md5,
      playInfoExist: true,
      playInfoStr: info.playInfoStr,
      songId,
      volumeGain: info.volumeGain,
      fileSize: info.fileSize,
    };

    const audioPath = resolve(songDir, "audio");
    await writeFile(audioPath, audioBuffer);
    await this.writeMeta(songId, meta);

    this.trackIndex.set(songId, meta);

    // Notify frontend
    this.notifyPlayCacheUpdate(meta, 1);

    // Evict if over size limit
    await this.evictIfNeeded();
  }

  // #endregion

  // #region Eviction

  private async evictIfNeeded(): Promise<void> {
    const limitGB = this.config ? Number(this.config.userSettingSize) : 10;
    const currentGB = await this.getCachedSizeGB();

    if (currentGB <= limitGB) return;

    // Target 80% of the limit
    const targetGB = limitGB * 0.8;

    // Sort by lastAccessTime ascending (oldest first)
    const tracks = Array.from(this.trackIndex.values()).sort(
      (a, b) => a.lastAccessTime - b.lastAccessTime
    );

    let freedBytes = 0;
    const excessBytes = (currentGB - targetGB) * 1024 * 1024 * 1024;

    for (const track of tracks) {
      if (freedBytes >= excessBytes) break;
      await this.removeTrack(track.songId);
      freedBytes += track.fileSize;
    }
  }

  private async removeTrack(songId: string): Promise<void> {
    const meta = this.trackIndex.get(songId);
    this.trackIndex.delete(songId);

    const songDir = resolve(this.cachePath, songId);
    try {
      await rm(songDir, { recursive: true, force: true });
    } catch {
      // Already gone
    }

    if (meta) {
      this.notifyPlayCacheUpdate(meta, 2);
    }
  }

  async clearAll(): Promise<void> {
    await this.ready();
    const tracks = Array.from(this.trackIndex.values());
    this.trackIndex.clear();
    try {
      await rm(this.cachePath, { recursive: true, force: true });
    } catch {
      // Already gone
    }
    for (const meta of tracks) {
      this.notifyPlayCacheUpdate(meta, 2);
    }
  }

  // #endregion

  // #region Helpers

  private async writeMeta(songId: string, meta: CacheTrackMeta): Promise<void> {
    const metaPath = resolve(this.cachePath, songId, "meta.json");
    await writeFile(metaPath, JSON.stringify(meta));
  }

  private notifyPlayCacheUpdate(
    meta: CacheTrackMeta,
    playCacheUpdateType: number
  ): void {
    try {
      mainWindow?.webContents.send(
        "channel.call",
        "storage.onPlayCacheUpdate",
        {
          ...meta,
          playCacheUpdateType,
        }
      );
    } catch {
      // Window might be destroyed
    }
  }

  private async getCachedSizeGB(): Promise<number> {
    let totalBytes = 0;
    for (const meta of this.trackIndex.values()) {
      totalBytes += meta.fileSize;
    }
    return totalBytes / (1024 * 1024 * 1024);
  }

  private async getDiskFreeGB(): Promise<number> {
    try {
      const stats = await statfs(this.cachePath);
      return (stats.bfree * stats.bsize) / (1024 * 1024 * 1024);
    } catch {
      return 0;
    }
  }

  // #endregion
}

// #endregion
