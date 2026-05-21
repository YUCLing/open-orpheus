import { exposeApi } from "../bridge/preload";

exposeApi("desktopLyrics", {
  platform: process.platform,
});
exposeApi("inputRegion", {
  platform: process.platform,
});
exposeApi("lyrics");
