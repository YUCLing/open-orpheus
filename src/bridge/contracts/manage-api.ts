import type { UpdateInfo } from "$sharedTypes/update";
import type { CacheGroupStats, AllCacheStats } from "$sharedTypes/manage";

export type { CacheGroupStats, AllCacheStats };

export interface ManageContract {
  platform: NodeJS.Platform;
  versions: NodeJS.ProcessVersions;

  checkUpdate(ignoreCache?: boolean): Promise<UpdateInfo | null>;

  pack: {
    getWebPackCommitHash(): Promise<string>;
    redownloadPackage(): Promise<void>;
  };
  cache: {
    getStats(): Promise<AllCacheStats>;
    clearResources(
      category: "http" | "http:vacuum" | "lyrics" | "wasm"
    ): Promise<void>;
  };
  protocol: {
    isClient(): Promise<boolean>;
    getClientName(): Promise<string>;
    setAsClient(isClient: boolean): Promise<void>;
  };
  gpu: {
    openInfo(): Promise<void>;
  };
  menu: {
    enableDefaultMenu(): Promise<void>;
  };
}
