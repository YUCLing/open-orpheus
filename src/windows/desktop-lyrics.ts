import { exposeApi } from "../bridge/preload";

exposeApi("desktopLyrics");
exposeApi("inputRegion", {
  platform: process.platform,
});
