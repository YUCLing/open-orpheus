import { registerCallHandler } from "../calls";

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
registerCallHandler<[], []>("app.getABTestKeys", () => []);
registerCallHandler<[Record<string, boolean>], void>("app.abtestSwitch", () => { /* empty */ });
registerCallHandler<[Record<string, object>], void>("app.abtestSwitchV2", () => { /* empty */ });

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
registerCallHandler<[], void>("app.appStartUpEnd", () => { /* empty */ });

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
