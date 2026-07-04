import path from "node:path";
import os from "node:os";
import { mkdir, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

import { app, dialog, Menu, protocol, session } from "electron";

import started from "electron-squirrel-startup";

// We want to hook Wayland connections as early as possible.
import "@open-orpheus/window";

import { onExit } from "@open-orpheus/lifecycle";

// Handle errors as early as possible
import "./main/error";

import {
  data as dataDir,
  disableHardwareAccelerationFlag,
  downloadTemp as downloadTempDir,
  streamerTemp as streamerTempDir,
  userdata as userdataDir,
} from "./main/folders";
import { prepareDeviceId } from "./main/device";
import { CORE_VERSION } from "./constants";
import packManager from "./main/pack";
import showPackgeDownloadWindow from "./main/windows/package-download";
import { mainWindow } from "./main/window";
import registerAsProtocolClient, {
  checkOpenCommand as checkWebCommand,
} from "./main/protocol";
import { toError } from "./util";

import type WebPack from "./main/packs/WebPack";
import type { ProxyConfiguration } from "./main/request";
import {
  LifecycleState,
  setLifecycleState,
  state as lifecycleState,
} from "./main/lifecycle";
import { checkEnvFlagPresent, isFileNotFound } from "./main/util";

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// Enforce single instance
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// Register privileged schemes
protocol.registerSchemesAsPrivileged([
  {
    scheme: "orpheus",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: "gui",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: "audio",
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      bypassCSP: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

app.setPath("userData", userdataDir);

// Allow NCM to hack on `window.channel`
// see https://github.com/electron/electron/blob/c2a0ec9931096ec83441521c8a75449cae96cd85/shell/renderer/api/electron_api_context_bridge.cc#L37
// see https://github.com/YUCLing/open-orpheus/pull/105#issue-4520228513
app.commandLine.appendSwitch("enable-features", "ContextBridgeMutability");

if (existsSync(disableHardwareAccelerationFlag)) {
  app.disableHardwareAcceleration();
}

if (app.isPackaged && !checkEnvFlagPresent("ENABLE_ELECTRON_MENUS"))
  // Tell Electron we don't need a menu before Electron tries to create one,
  // this benefits the startup time
  Menu.setApplicationMenu(null);

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on("ready", async () => {
  try {
    // Make sure data directory exists
    await mkdir(path.join(dataDir), { recursive: true });

    let userAgent = session.defaultSession.getUserAgent();
    if (os.platform() === "linux") {
      // Make some modules think we are indeed on desktop.
      userAgent = userAgent.replace(
        /^(Mozilla\/5\.0 \([^)]*\))/,
        "Mozilla/5.0 (Windows NT 10.0; WOW64)"
      );
    }
    session.defaultSession.setUserAgent(
      `${userAgent} NeteaseMusicDesktop/${CORE_VERSION}`
    );
    session.defaultSession.setDisplayMediaRequestHandler(
      async (request, callback) => {
        if (!request.frame) {
          callback({});
          return;
        }
        callback({
          video: request.frame,
          audio: "loopback",
        });
      }
    );

    const openOrpheusSession = session.fromPartition("open-orpheus");

    await import("./main/gui").then((m) => {
      // Register GUI scheme for Open Orpheus session now, package download window might need it
      m.default(openOrpheusSession.protocol);
    });

    const shouldRedownload = process.argv.includes("--redownload-package");
    try {
      // Trigger an error to redownload the package if requested
      if (shouldRedownload) throw new Error("REDOWNLOAD_REQ");
      await packManager.loadWebPack();
    } catch (e) {
      if (!(e instanceof Error) || e.message !== "REDOWNLOAD_REQ")
        console.warn("Failed to load web pack:", e);
      await showPackgeDownloadWindow(); // If user cancelled, this will throw and skip the rest of initialization
      if (shouldRedownload) {
        // Redownload is successfully here, drop the argument then restart again
        app.relaunch({
          args: process.argv.filter((v) => v !== "--redownload-package"),
        });
        app.quit();
        return;
      }
      await packManager.loadWebPack(); // Simply try loading again after download, it will throw if the package is still invalid
    }

    // Some pages need window.channel, but do not really use
    app.on("web-contents-created", (e, wc) => {
      if (wc.session !== session.defaultSession) return; // Only enable for default session

      wc.on("frame-created", (event, details) => {
        const frame = details.frame;
        if (!frame) return;

        frame.on("dom-ready", () => {
          if (frame.isDestroyed()) return;
          const url = new URL(frame.url);
          // We want only secure, trusted pages
          if (
            url.protocol === "https:" ||
            url.hostname.endsWith("music.163.com")
          )
            frame.executeJavaScript("window.channel = window.channel ?? {};");
        });
      });
    });

    // Initialize schemes and get registrars
    const [registerOrpheusScheme, registerAudioScheme] = await Promise.all([
      import("./main/orpheus").then((m) => m.default),
      import("./main/audio").then((m) => m.default),
    ]);

    // Register for default session
    registerOrpheusScheme(protocol);
    registerAudioScheme(protocol);

    // Register for Open Orpheus session
    registerOrpheusScheme(openOrpheusSession.protocol);

    await import("./main/database").then(async (m) => {
      m.initializeDatabases();
      await import("./main/settings").then((m) => m.initialize());
    });

    await Promise.all([
      // Install the tray icon
      import("./main/tray"),
      // Set temp dir for streamer and run cleanup
      import("./main/audio/OnlineStreamer").then(async (m) => {
        m.OnlineStreamer.tempDir = streamerTempDir;
        // This will be done in the background, the OnlineStreamer will know what files are
        // currently being used, cleanup will only clean the leftovers from previous usages.
        m.OnlineStreamer.cleanup().catch((e) => {
          console.error("Failed to cleanup OnlineStreamer temporary files:", e);
        });
      }),
      (async () => {
        try {
          const entries = await readdir(downloadTempDir);
          for (const entry of entries) {
            // Fire-and-forget for existing files
            rm(path.resolve(downloadTempDir, entry), {
              force: true,
              recursive: true,
            }).catch((e) =>
              console.error("Failed to delete download temp file", entry, e)
            );
          }
        } catch (err) {
          if (isFileNotFound(err)) return;
          console.error("Failed to cleanup download temp", err);
        }
      })(),
      import("./main/afp"),
      import("./main/fonts"),
      import("./main/channel"),
      import("./main/request").then(async (m) => {
        m.setupRequestInterceptors();

        // Apply stored proxy settings
        const { kv: settings } = await import("./main/settings");
        const proxy = await settings.get("proxy");
        if (typeof proxy !== "string" || !proxy) return;

        try {
          const cfg: ProxyConfiguration = JSON.parse(proxy);

          switch (cfg.Type) {
            case "ie":
              app.setProxy({ mode: "system" });
              break;
            case "http":
            case "socks4":
            case "socks5": {
              const srv = cfg[cfg.Type]!;
              app.setProxy({
                mode: "fixed_servers",
                proxyRules: `${cfg.Type}://${srv.Host}:${srv.Port}`,
              });
              if (srv.UserName || srv.Password) {
                app.on("login", (event, wc, request, authInfo, callback) => {
                  if (!authInfo.isProxy) return;
                  event.preventDefault();
                  callback(srv.UserName, srv.Password);
                });
              }
              break;
            }
            default:
              app.setProxy({ mode: "direct" });
              break;
          }

          const agents = await m.getProxyAgent(cfg);
          m.setProxy(agents);
        } catch (err) {
          console.warn("Failed to get proxy configuration", err);
        }
      }),
      prepareDeviceId().then(async () => {
        // Initialize initial cookies
        await (await import("./main/cookie")).default();
      }),
      packManager.getPack<WebPack>("web").readPack(),
      import("./main/windows/desktop-lyrics").then((m) => {
        // Create desktop lyrics window
        m.default();
      }),
      import("./main/windows/mini-player").then((m) => {
        // Create mini player window
        m.default();
      }),
    ]);

    onExit(() => {
      app.quit(); // Graceful exit
    });

    // Create main window
    await (await import("./main/windows/main")).default();

    // TODO: Maybe only do this on first launch?
    // Register as orpheus:// clent
    registerAsProtocolClient();

    // Run a update check
    import("./main/update").then((m) => m.checkUpdate());
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
  if (lifecycleState !== LifecycleState.Starting) {
    app.quit();
  }
});

app.on("before-quit", () => {
  // Allow some windows to be closed.
  setLifecycleState(LifecycleState.Quitting);
});

app.on("second-instance", (event, argv) => {
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
