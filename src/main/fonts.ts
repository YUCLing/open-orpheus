import { getScFonts } from "@open-orpheus/ui";

import { events as lifecycleEvents } from "./lifecycle";
import { toError } from "@shared/util";

lifecycleEvents.on("mainwindowcreated", (e) => {
  const mainWindow = e.data;

  mainWindow.webContents.ipc.handle("fonts.getSCFonts", async () => {
    try {
      return await getScFonts();
    } catch (err) {
      LOGGER.error({ err: toError(err) }, "Failed to list system fonts");
      throw err;
    }
  });
});
