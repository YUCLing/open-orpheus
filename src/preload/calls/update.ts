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
