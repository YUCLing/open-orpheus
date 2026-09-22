// Settles PLAN.md §9 Q3: may a sandboxed preload evaluate code at runtime?
//
// `sandbox: true` with `contextIsolation: true` mirrors the real windows' web
// preferences (Electron 20+ defaults, and nothing in src/main sets sandbox: false).
// The answer decides whether the preload plugin plane can install code at runtime
// (Option A) or must be concatenated at build time (Option B) — see §8.3 / §9.2.
//
// Run: pnpm exec electron scripts/spike-preload-eval/main.cjs
// Expect: SPIKE_RESULT with newFunction/eval results, and node:fs rejected.
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

app.whenReady().then(() => {
  const wnd = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  ipcMain.once("spike:result", (_event, results) => {
    console.log("SPIKE_RESULT " + JSON.stringify(results));
    app.exit(0);
  });

  wnd.loadURL("data:text/html,<html><body>spike</body></html>");

  setTimeout(() => {
    console.log("SPIKE_RESULT timeout");
    app.exit(1);
  }, 15000);
});
