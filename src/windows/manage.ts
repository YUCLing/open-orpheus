import { exposeApi } from "../preload/bridge";

exposeApi("manage", {
  platform: process.platform,
  versions: process.versions,
});
exposeApi("settings");
