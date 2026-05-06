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
  enabled: boolean;
  installed: boolean;
  message: string;
};

export type TrayLyricsExtensionInfo = {
  installed: boolean;
  recognized: boolean;
  enabled: boolean;
  version: number | null;
  upToDate: boolean;
  needsSessionRestart: boolean;
};

export type TrayLyricsStyle = {
  fontFamily: string;
  color: string;
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
    getExtensionInfo(): Promise<TrayLyricsExtensionInfo>;
    installExtension(): Promise<TrayLyricsExtensionInstallResult>;
    getSystemFonts(): Promise<string[]>;
    getStyle(): Promise<TrayLyricsStyle>;
    setStyle(style: TrayLyricsStyle): Promise<TrayLyricsStyle>;
  };
}
