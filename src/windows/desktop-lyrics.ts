import { exposeApi } from "../preload/bridge";

exposeApi("desktopLyrics", {
  platform: process.platform,
});
exposeApi("inputRegion", {
  platform: process.platform,
});
exposeApi("lyrics");
exposeApi("settings");
