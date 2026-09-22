// Setup logger as early as possible
import "@main/logger";

// We want to hook Wayland connections as early as possible.
import "@open-orpheus/window";

// Handle errors as early as possible
import "@main/platform/error";

import { app, dialog } from "electron";

import { toError } from "@shared/util";
import {
  LifecycleState,
  setLifecycleState,
  currentState,
} from "@main/lifecycle";
import { configureProcess } from "@main/bootstrap/process-setup";
import { checkOpenCommand as checkWebCommand } from "@main/platform/protocol";
import { startApplication } from "@main/bootstrap/startup";
import { windowService } from "@main/services/window";

configureProcess();

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on("ready", async () => {
  try {
    await startApplication();
  } catch (error) {
    if (error) {
      dialog.showErrorBox(
        "Initialization Failed",
        "An error occurred during application initialization. Open Orpheus will now exit.\n\nDetails:\n" +
          (toError(error).stack ?? toError(error).message)
      );
    }
    app.exit(1);
  }
});

app.on("window-all-closed", () => {
  // Make sure we don't quit because of package download window being closed before main window has started
  if (currentState() !== LifecycleState.Starting) {
    app.quit();
  }
});

app.on("before-quit", () => {
  // Allow some windows to be closed.
  setLifecycleState(LifecycleState.Quitting);
});

app.on("second-instance", (event, argv) => {
  const mainWindow = windowService.currentWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const cmd = checkWebCommand(argv);
  if (cmd) {
    mainWindow.webContents.send(
      "channel.call",
      "ipc.onipcmessagerecived",
      3,
      cmd
    );
    return;
  }
  mainWindow.webContents.send(
    "channel.call",
    "ipc.onipcmessagerecived",
    1,
    null
  );
});
