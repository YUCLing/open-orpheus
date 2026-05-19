import os from "node:os";

import { registerIpcHandlers } from "../register";
import { InputRegionContract } from "../contracts/input-region-api";
import { setWindowInputRegion } from "../../main/window";

export function registerInputRegionHandlers(wnd: Electron.BrowserWindow) {
  registerIpcHandlers<InputRegionContract>(wnd.webContents, "inputRegion", {
    setInputRegions: async (event, regions) => {
      if (!wnd || wnd.isDestroyed()) return;
      if (os.platform() === "linux") {
        setWindowInputRegion(wnd, regions);
      } else {
        // In Windows/macOS, we don't need to be so specific
        if (regions.length > 0) {
          wnd.setIgnoreMouseEvents(true, {
            forward: true,
          });
        } else {
          wnd.setIgnoreMouseEvents(false);
        }
      }
    },
  });

  wnd.on("show", () => {
    wnd.webContents.send("inputRegion.shown");
  });
}
