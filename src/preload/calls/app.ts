import { SECRET_KEY } from "../../constants";
import { registerCallHandler } from "../calls";
import { fireNativeCall } from "../channel";

// These are not needed?
registerCallHandler<[], void>("app.statis", () => {
  /* empty */
});
registerCallHandler<[], void>("app.statisV2", () => {
  /* empty */
});
registerCallHandler<[], void>("app.sendStatis", () => {
  /* empty */
});

// Need more info on these
registerCallHandler<[], string[]>("app.getABTestKeys", () => [
  //"PH-PC-DAWNLOG-NEW",
  //"PC-blur-enable",
  //"PH-PC-P2P-Enable",
  //"PC-GPU-enable",
  //"PC-httpdns-resource-enable",
  //"PC-httpdns-enable",
  //"PC-httpdns-api-enable",
  //"PC-cronet-enable-ver",
  //"PH-PC-SYSTEM_LOCK_RECOVER_NEW",
  //"PH-PC-Xunlei-SDK-Strategy",
  //"PH-PC-API-HORSERACE",
  //"PH-PC-HIDE_ZERO_SIZE",
  //"PH-PC-REQUEST_RANGE_ALIGN",
  //"PH-PC-newNetLibV2",
  "PH-PC-newAPMLIBV2", // 新主页和播放器样式
  //"PH-PC-TASKBAR_ICON_WINDOW",
  //"PH-PC-IPV6Enable",
  //"PH-PC-PERF_MONITOR_ENABLE",
  //"PH-PC-SAFEMODE-CLEAN-V3",
  //"PH-PC-BOOTMONITOR",
  //"PH-PC-AsyncDNS",
  //"PH-PC-HTTPDNS_IPRACE",
]);
registerCallHandler<[Record<string, boolean>], void>("app.abtestSwitch", () => {
  /* empty */
});
registerCallHandler<[Record<string, object>], void>(
  "app.abtestSwitchV2",
  () => {
    /* empty */
  }
);

registerCallHandler<[], void>("app.getAppStartCommand", () => {
  /* empty */
});

registerCallHandler<
  [
    {
      patchVersion: string;
    },
  ],
  void
>("app.onBootFinish", () => {
  /* empty */
});
registerCallHandler<[], void>("app.appStartUpEnd", () => {
  /* empty */
});

const cooperation = {
  main: "",
  sub: "",
};
registerCallHandler<[], [typeof cooperation]>("app.getCooperation", () => [
  cooperation,
]);

registerCallHandler<[], [string]>("app.getAppStartTime", () => {
  // TODO: Implement this properly
  return ["542493"]; // What is this?
});

registerCallHandler<[], [string]>("app.getAppStartType", () => {
  return [""];
});

registerCallHandler<[], [boolean]>("app.initUrls", () => {
  // TODO: Implement this properly? What does this even do?
  return [true];
});

// TODO: Implement this properly
registerCallHandler<[], [boolean]>("app.loadSkinPackets", () => [true]);

registerCallHandler<[string, string, object], void>(
  "app.getNativeData",
  (taskId, key) => {
    switch (key) {
      case "secretKey":
        // Frontend only register the call AFTER this call,
        // so setImmediate to ensure the callback is registered
        setImmediate(() => {
          fireNativeCall("app.onGetNativeData", taskId, key, {
            secretKey: SECRET_KEY,
          });
        });
        break;
    }
  }
);
