import type { InputRegion } from "@shared/types/input-region";

export type { InputRegion };

export interface InputRegionContract {
  platform: NodeJS.Platform;
  setInputRegions(regions: InputRegion[]): Promise<boolean>;

  events: {
    shown(callback: () => void): void;
  };
}
