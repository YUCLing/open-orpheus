import {
  BUILD,
  CORE_VERSION,
  NATIVE_VERSION,
  VERSION,
} from "@shared/constants";
import { registerCallHandler } from "../calls";

registerCallHandler<[string], [string, string]>(
  "update.getVersion",
  (module) => {
    // TODO: Implement this properly
    if (module === "core") {
      return [CORE_VERSION, "64"];
    } else if (module === "native") {
      return [NATIVE_VERSION, "64"];
    }
    return ["", "64"];
  }
);

const visualVersion = {
  app_platform: "64",
  build: BUILD,
  version: VERSION,
};
registerCallHandler<[], [typeof visualVersion]>(
  "update.getVisualVersion",
  () => {
    // TODO: Implement this properly
    return [visualVersion];
  }
);

// Maybe we don't need this in the future
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const cachedInstallPackageVersion = {
  buildVer: BUILD,
  mainVer: VERSION,
  md5: "B3025C21309C614E088032A206DFFF01",
  path: "C:\\Users\\steamuser\\AppData\\Local\\NetEase\\CloudMusic\\update\\orpheus_install.exe",
  version: CORE_VERSION,
};
registerCallHandler<[], (typeof cachedInstallPackageVersion)[]>(
  "update.getCachedInstallPackageVersion",
  () => {
    // We are not interested in incremental update pack, return empty.
    return [];
  }
);
