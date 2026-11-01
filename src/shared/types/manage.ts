export interface CacheGroupStats {
  entryCount: number;
  sizeBytes: number;
  /** If this is provided, it means that `sizeBytes` is only the actual data size,
   * that is not the actual data size on disk (might still be occupied by leftover data).
   */
  sizeBytesOnDisk?: number;
}

export interface AllCacheStats {
  play: CacheGroupStats;
  http: CacheGroupStats;
  lyrics: CacheGroupStats;
  wasm: CacheGroupStats;
}
