import type { InputRegion } from "$sharedTypes/input-region";

export type { InputRegion };

export interface InputRegionContract {
  platform: NodeJS.Platform;
  setInputRegions(regions: InputRegion[]): Promise<boolean>;
}
