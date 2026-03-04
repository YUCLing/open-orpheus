import { registerCallHandler } from "../calls";

type PlayCacheInfoBase = {
  ABName: string;
  autoCacheSize: string;
  configJson: string;
  groupName: string;
  manuSetting: unknown,
  settingLowLimit: string;
  settingUpLimit: string;
  userSettingSize: string;
};
registerCallHandler<PlayCacheInfoBase[], void>("storage.setPlayCacheConfig", () => { return });

type PlayCacheInfo = PlayCacheInfoBase & {
  autoCacheSize: number;
  autoCacheSizeReal: number;
  cachePath: string;
  clearLimitMax: number;
  clearToLimit: number;
  currentCachedSize: number;
  diskFreeSize: number;
  manuSetting: boolean;
  settingLowLimit: number;
  settingUpLimit: number;
  userSettingSize: number;
  userSettingSizeReal: number;
};
registerCallHandler<[], PlayCacheInfo[]>("storage.playCacheInfo", () => {
  return [];
});
