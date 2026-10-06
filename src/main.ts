// Setup logger as early as possible
import "@main/platform/logger";

// We want to hook Wayland connections as early as possible.
import "@open-orpheus/window";

// Handle errors as early as possible
import "@main/bootstrap/error";

import { app, dialog } from "electron";

import { toError } from "@shared/util";
import logger from "@main/platform/logger";
import { installLifecycle, registerShutdownTask, setStartupTask } from "@main/services/lifecycle";
import { configureProcess } from "@main/bootstrap/process-setup";
import { parseLocalFile, parseWebCommand, raceArgument } from "@main/platform/arguments";
import { fileExists, isMusicFile } from "@main/platform/util";
import { startApplication, type Application } from "@main/bootstrap/startup";

configureProcess();

// What start-up produced: the app-scoped registrations and this process's
// window service. Both are owned here rather than imported from a module-level
// singleton, so nothing outside `bootstrap()` can reach the window state.
let application: Application | undefined;

// Signals and quitting are wired as early as possible, so a signal arriving
// during start-up still exits with the right code. This owns the
// `window-all-closed` and `before-quit` handlers the entry used to hand-roll.
installLifecycle({ logger });

// §3.3: the app-scoped registrations are torn down as one step of the shutdown
// sequence, rather than from a second `before-quit` listener.
registerShutdownTask({
  name: "app-registrations",
  run: () => application?.registrations.dispose(),
});

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on("ready", async () => {
  try {
    application = await startApplication();
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

// Both of these can fire before `ready` on macOS, which is what `setStartupTask`
// is for: the request is recorded and picked up once the app is up. The renderer
// is only told about them when a window already exists.
app.on("open-file", (e, path) => {
  e.preventDefault();
  setStartupTask({
    type: "openFile",
    file: path,
  });
  const mainWindow = application?.windows.currentWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("channel.call", "ipc.onipcmessagerecived", 2, path);
});

app.on("open-url", (e, url) => {
  if (!url.startsWith("orpheus://")) return;
  e.preventDefault();
  setStartupTask({
    type: "openUrl",
    url,
  });
  const mainWindow = application?.windows.currentWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("channel.call", "ipc.onipcmessagerecived", 3, url);
});

app.on("second-instance", async (event, argv) => {
  // Undefined until start-up resolves, which is also when a main window can
  // first exist — the same early return the module-level singleton produced.
  const mainWindow = application?.windows.currentWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const cmd = await raceArgument<[number, string]>(async (arg) => {
    const webCmd = parseWebCommand(arg);
    if (webCmd) return [3, webCmd];
    const localFile = await parseLocalFile(arg, { fileExists, isMusicFile });
    if (localFile) return [2, localFile];
    return null;
  }, argv);
  if (cmd) {
    mainWindow.webContents.send("channel.call", "ipc.onipcmessagerecived", ...cmd);
    return;
  }
  mainWindow.webContents.send("channel.call", "ipc.onipcmessagerecived", 1, null);
});
