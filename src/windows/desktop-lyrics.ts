import os from "node:os";

import { exposeApi } from "../bridge/preload";

exposeApi("desktopLyrics", {
  platform: os.platform(),
});
