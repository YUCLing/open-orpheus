import { getCjkFonts } from "@open-orpheus/ui";
import { events as lifecycleEvents } from "./lifecycle";

lifecycleEvents.on("mainwindowcreated", (e) => {
  const mainWindow = e.data;

  mainWindow.webContents.ipc.handle("fonts.getCJKFonts", async () => {
    return await getCjkFonts();
  });
});
