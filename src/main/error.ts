import { app, dialog } from "electron";

let uncaughtExceptionCount = 0;

process.on("uncaughtException", (error) => {
  LOGGER.fatal({ err: error }, "Uncaught main-process exception");
  // Avoid spamming
  if (uncaughtExceptionCount === 0)
    dialog.showErrorBox(
      "Oops! An error occurred!",
      "Open Orpheus will now exit.\n\nDetails:\n" + (error.stack || error.message || error)
    );
  uncaughtExceptionCount++;
  app.exit(1);
});
