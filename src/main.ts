import path from "node:path";
import os from "node:os";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import { app, dialog, Menu, protocol, session } from "electron";

import started from "electron-squirrel-startup";

// Setup logger as early as possible
import logger from "./main/logger";

// We want to hook Wayland connections as early as possible.
import "@open-orpheus/window";

import { onExit } from "@open-orpheus/lifecycle";

// Handle errors as early as possible
import "./main/error";

import {
  data as dataDir,
  disableHardwareAccelerationFlag,
  downloadTemp as downloadTempDir,
  lastWebpackHash as lastWebpackHashPath,
  streamerTemp as streamerTempDir,
  userdata as userdataDir,
} from "./main/folders";
import { prepareDeviceId } from "./main/device";
import { CORE_VERSION } from "./constants";
import versions from "../versions.json";
import packManager, { NO_WEBPACK_ERROR_MESSAGE } from "./main/pack";
import showPackgeDownloadWindow from "./main/windows/package-download";
import { mainWindow } from "./main/window";
import registerAsProtocolClient, {
  checkOpenCommand as checkWebCommand,
} from "./main/protocol";
import { toError } from "./util";
import {
  LifecycleState,
  setLifecycleState,
  state as lifecycleState,
} from "./main/lifecycle";
import { checkEnvFlagPresent, isFileNotFound } from "./main/util";
import { PackageDownloadReason } from "$sharedTypes/package-download";

import type WebPack from "./main/packs/WebPack";
import type { ProxyConfiguration } from "./main/request";

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// Enforce single instance
if (!app.requestSingleInstanceLock()) {
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

app.setAppUserModelId("com.squirrel.OpenOrpheus.OpenOrpheus");

// Allow NCM to hack on `window.channel`
// see https://github.com/electron/electron/blob/c2a0ec9931096ec83441521c8a75449cae96cd85/shell/renderer/api/electron_api_context_bridge.cc#L37
// see https://github.com/YUCLing/open-orpheus/pull/105#issue-4520228513
app.commandLine.appendSwitch("enable-features", "ContextBridgeMutability");
app.commandLine.appendSwitch("disable-features", "MediaSessionService");

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

    // The versions.commit that we've already installed or offered to the user
    // through the download window. It prevents re-offering the window on every
    // launch for the same version (e.g. after the user cancels). `null` means
    // we've never recorded one yet.
    let offeredWebPackCommit: string | null = await readFile(
      lastWebpackHashPath,
      {
        encoding: "utf-8",
      }
    )
      .then((content) => content.trim() || null)
      .catch((err) => {
        if (!isFileNotFound(err)) {
          logger.warn(
            { name: "loader", err: toError(err) },
            "Cannot read last web pack commit hash."
          );
        }
        return null;
      });

    let shouldRedownload = process.argv.includes("--redownload-package");

    // Make sure the web pack on disk matches versions.commit. Whenever it
    // doesn't — the version changed, or the pack is missing/corrupt — show
    // the download window, then reload the freshly downloaded pack.
    while (true) {
      let downloadReason: PackageDownloadReason | null = null;

      if (shouldRedownload) {
        downloadReason = PackageDownloadReason.UserRequested;
      } else {
        try {
          await packManager.loadWebPack();
          const webPackCommit = await packManager
            .getPack<WebPack>("web")
            .getCommitHash();
          // Offer the update when the installed pack doesn't match the commit
          // versions.json expects, but only once per commit — once the user
          // has been offered it (or cancelled), don't nag again.
          if (
            webPackCommit !== versions.commit &&
            offeredWebPackCommit !== versions.commit
          ) {
            downloadReason = PackageDownloadReason.UpdateAvailable;
          }
        } catch (err) {
          logger.error(
            { name: "loader", err: toError(err) },
            "Failed to load web pack."
          );
          downloadReason =
            err instanceof Error && err.message === NO_WEBPACK_ERROR_MESSAGE
              ? PackageDownloadReason.NotFound
              : PackageDownloadReason.LoadFailed;
        }
      }

      // We have a usable web pack that matches versions.commit
      if (downloadReason === null) break;

      // Show the download window. It resolves when the download completes and
      // rejects if the user cancels or the download fails.
      let cancelled = false;
      let failed = false;
      try {
        await showPackgeDownloadWindow(downloadReason);
      } catch (e) {
        cancelled = true;
        if (e !== "CANCEL") {
          failed = true;
          logger.error(
            { name: "loader", err: toError(e) },
            "Failed to download web pack."
          );
        }
      }

      // Remember this commit so we don't offer the download again on the next
      // launch, whether the user downloaded, cancelled, or the download failed.
      offeredWebPackCommit = versions.commit;
      await writeFile(lastWebpackHashPath, offeredWebPackCommit).catch((e) => {
        logger.warn(
          { name: "loader", err: toError(e) },
          "Cannot save current web pack commit hash."
        );
      });

      if (cancelled) {
        // The download didn't complete (cancelled or failed). If a usable pack
        // is already on disk, keep launching with it; otherwise there is
        // nothing to run with, so exit instead of looping forever.
        const noUsablePack =
          downloadReason === PackageDownloadReason.NotFound ||
          downloadReason === PackageDownloadReason.LoadFailed;
        if (failed) {
          dialog.showErrorBox(
            "Open Orpheus",
            noUsablePack
              ? "资源包下载失败"
              : "资源包下载失败\n可通过 Open Orpheus 管理界面重新尝试下载"
          );
        }
        if (noUsablePack) {
          app.exit(1);
          return;
        }
        if (shouldRedownload) {
          // Cancelled or failed the forced redownload — drop the flag and use
          // the pack that is already on disk.
          shouldRedownload = false;
          continue;
        }
        // The loaded (even if mismatched) pack is usable; keep launching.
        break;
      }

      if (shouldRedownload) {
        // Download succeeded, drop the flag and restart cleanly
        app.relaunch({
          args: process.argv.filter((v) => v !== "--redownload-package"),
        });
        app.quit();
        return;
      }
      // Loop to load the freshly downloaded web pack
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
      await m.initializeDatabases();
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
          logger.error(
            { name: "loader", err: toError(e) },
            `Failed to cleanup OnlineStreamer temporary files`
          );
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
              logger.error(
                { name: "loader", err: toError(e), file: entry },
                `Failed to delete download temporary file`
              )
            );
          }
        } catch (err) {
          if (isFileNotFound(err)) return;
          logger.error(
            { name: "loader", err: toError(err) },
            `Failed to cleanup download temp`
          );
        }
      })(),
      import("./main/afp"),
      import("./main/fonts"),
      import("./main/mediaSession").then((m) => m.createMediaSession()),
      import("./main/channel"),
      import("./main/request").then(async (m) => {
        m.setupRequestInterceptors();

        // Set the proxy for both the app and our sessions
        const setProxy = async (config: Parameters<typeof app.setProxy>[0]) => {
          await Promise.all([
            app.setProxy(config),
            session.defaultSession.setProxy(config),
            openOrpheusSession.setProxy(config),
          ]);
        };

        // Apply stored proxy settings
        const { kv: settings } = await import("./main/settings");
        const proxy = await settings.get("proxy");
        if (typeof proxy !== "string" || !proxy) return;

        try {
          const cfg: ProxyConfiguration = JSON.parse(proxy);

          switch (cfg.Type) {
            case "ie":
              await setProxy({ mode: "system" });
              break;
            case "http":
            case "socks4":
            case "socks5": {
              const srv = cfg[cfg.Type]!;
              await setProxy({
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
              await setProxy({ mode: "direct" });
              break;
          }

          const agents = await m.getProxyAgent(cfg);
          m.setProxy(agents);
        } catch (err) {
          logger.warn(
            { name: "proxy" },
            "Failed to load proxy configuration: %s",
            err
          );
        }
      }),
      prepareDeviceId().then(async () => {
        // Initialize initial cookies
        await (await import("./main/cookie")).default();
      }),
      packManager.getPack<WebPack>("web").readPack(),
      import("./main/windows/desktop-lyrics").then(async (m) => {
        // Create desktop lyrics window
        await m.default();
      }),
      import("./main/windows/mini-player").then(async (m) => {
        // Create mini player window
        await m.default();
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
