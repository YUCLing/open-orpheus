import os from "node:os";

import { registerIpcHandlers } from "../register";
import { InputRegionContract } from "../contracts/input-region-api";
import { ManagedWindow } from "../../main/window";

export function registerInputRegionHandlers(wnd: Electron.BrowserWindow) {
  registerIpcHandlers<InputRegionContract>(wnd.webContents, "inputRegion", {
    setInputRegions: async (event, regions) => {
      if (!wnd || wnd.isDestroyed()) return false;
      if (os.platform() === "linux") {
        const managed = ManagedWindow.fromBrowserWindow(wnd);
        if (!managed) return false;
        return managed.setWindowInputRegion(regions);
      } else {
        // In Windows/macOS, we don't need to be so specific
        if (regions.length > 0) {
          wnd.setIgnoreMouseEvents(true, {
            forward: true,
          });
        } else {
          wnd.setIgnoreMouseEvents(false);
        }
        return true;
      }
    },
  });

  wnd.on("show", () => {
    wnd.webContents.send("inputRegion.shown");
  });
}
