import type { UpdateInfo } from "../main/update";

export interface CacheGroupStats {
  entryCount: number;
  sizeBytes: number;
}

export interface AllCacheStats {
  play: CacheGroupStats;
  http: CacheGroupStats;
  lyrics: CacheGroupStats;
  wasm: CacheGroupStats;
}

export type TrayLyricsExtensionInstallResult = {
  ok: boolean;
  enabled: boolean;
  installed: boolean;
  needsRelogin: boolean;
  message: string;
};

export interface ManageContract {
  platform: NodeJS.Platform;

  checkUpdate(ignoreCache?: boolean): Promise<UpdateInfo | null>;

  pack: {
    getWebPackCommitHash(): Promise<string>;
    redownloadPackage(): Promise<void>;
  };
  cache: {
    getStats(): Promise<AllCacheStats>;
    clearResources(category: "http" | "lyrics" | "wasm"): Promise<void>;
  };
  gpu: {
    openInfo(): Promise<void>;
  };
  trayLyrics: {
    isExtensionInstalled(): Promise<boolean>;
    installExtension(): Promise<TrayLyricsExtensionInstallResult>;
  };
}
