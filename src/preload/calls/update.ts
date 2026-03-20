import {
  BUILD,
  CORE_VERSION,
  MD5,
  NATIVE_VERSION,
  VERSION,
} from "../../constants";
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
    return ["", "64"] as unknown as [string, string];
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

const cachedInstallPackageVersion = {
  buildVer: BUILD,
  mainVer: VERSION,
  md5: MD5,
  path: "C:\\Users\\steamuser\\AppData\\Local\\NetEase\\CloudMusic\\update\\orpheus_install.exe",
  version: CORE_VERSION,
};
registerCallHandler<[], [typeof cachedInstallPackageVersion]>(
  "update.getCachedInstallPackageVersion",
  () => {
    return [cachedInstallPackageVersion];
  }
);
