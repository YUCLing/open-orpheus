import { registerCallHandler } from "../calls";

registerCallHandler<[string], [string, string]>(
  "update.getVersion",
  (module) => {
    // TODO: Implement this properly
    if (module === "core") {
      return ["3.1.28.205001", "64"];
    } else if (module === "native") {
      return ["60316", "64"];
    }
    return ["", "64"] as unknown as [string, string];
  }
);

const visualVersion = {
  app_platform: "64",
  build: "205001",
  version: "3.1.28",
};
registerCallHandler<[], [typeof visualVersion]>(
  "update.getVisualVersion",
  () => {
    // TODO: Implement this properly
    return [visualVersion];
  }
);

const cachedInstallPackageVersion = {
  buildVer: "205001",
  mainVer: "3.1.28",
  md5: "B3025C21309C614E088032A206DFFF01",
  path: "C:\\Users\\steamuser\\AppData\\Local\\NetEase\\CloudMusic\\update\\orpheus_install.exe",
  version: "3.1.28.205001",
};
registerCallHandler<[], [typeof cachedInstallPackageVersion]>(
  "update.getCachedInstallPackageVersion",
  () => {
    return [cachedInstallPackageVersion];
  }
);
