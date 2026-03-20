import { OSVER } from "../../constants";
import { registerCallHandler } from "../calls";
import { fireNativeCall } from "../channel";

registerCallHandler<[], [string]>("os.queryOsVer", () => {
  // TODO: Implement this properly
  return [OSVER];
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
