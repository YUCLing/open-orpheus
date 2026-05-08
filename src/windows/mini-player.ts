import { exposeApi } from "../bridge/preload";

exposeApi("miniPlayer");
exposeApi("inputRegion", {
  platform: process.platform,
});
