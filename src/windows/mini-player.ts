import { exposeApi } from "../preload/bridge";

exposeApi("miniPlayer");
exposeApi("inputRegion", {
  platform: process.platform,
});
exposeApi("lyrics");
