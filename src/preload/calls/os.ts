import { registerCallHandler } from "../calls";

registerCallHandler<[], [string]>("os.queryOsVer", () => {
  // TODO: Implement this properly
  return ["Microsoft-Windows-11--build-22631-64bit"];
});

registerCallHandler<[], [string]>("os.getDeviceId", () => {
  // TODO: Implement this properly
  return ["fake-device-id"];
});

registerCallHandler<[], [string]>("os.getADDeviceID", () => {
  // TODO: Implement this properly
  return ["fake-ad-device-id"];
});

registerCallHandler<[], [{ enabled: boolean }]>(
  "os.isSystemDarkThemeEnabled",
  () => {
    return [{ enabled: false }];
  }
);

registerCallHandler<[string], [unknown]>("os.getSystemInfo", () => {
  // TODO: Implement this properly
  return [undefined];
});

registerCallHandler<[], [boolean]>("os.isOnLine", () => [navigator.onLine]);

// TODO: Implement this properly, it blocks the app from loading
registerCallHandler<string[], [string, string[]]>(
  "os.checkNativeSupportFonts",
  (...fonts) => {
    return ["success", fonts];
  }
);
