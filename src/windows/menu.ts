import { exposeApi } from "../preload/bridge";

exposeApi("menu");
exposeApi("inputRegion", {
  platform: process.platform,
});
