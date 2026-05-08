export interface InputRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InputRegionContract {
  platform: NodeJS.Platform;
  setInputRegions(regions: InputRegion[]): Promise<void>;
}
