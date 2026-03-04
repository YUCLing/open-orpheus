import { registerCallHandler } from "../calls";
import { fireNativeCall } from "../channel";

registerCallHandler<[], [string]>("os.queryOsVer", () => {
  // TODO: Implement this properly
  return ["Microsoft-Windows-11--build-22631-64bit"];
});

registerCallHandler<[], [{ enabled: boolean }]>(
  "os.isSystemDarkThemeEnabled",
  () => {
    return [{ enabled: false }];
  }
);

registerCallHandler<[], void>("os.isOnLine", () => {
  fireNativeCall("os.onisonline", navigator.onLine);
});
