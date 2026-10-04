import { app, dialog } from "electron";

process.on("uncaughtException", (error) => {
  LOGGER.error({ err: error }, "Uncaught main-process exception");
  dialog.showErrorBox(
    "Oops! An error occurred!",
    "Open Orpheus will now exit.\n\nDetails:\n" + (error.stack || error.message || error)
  );
  app.exit(1);
});
