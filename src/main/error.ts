import { app, dialog } from "electron";

process.on("uncaughtException", (error) => {
  console.error("Uncaught main-process exception:", error);
  dialog.showErrorBox(
    "Oops! An error occurred!",
    "Open Orpheus will now exit.\n\nDetails:\n" + (error.stack || error.message || error)
  );
  app.exit(1);
});
