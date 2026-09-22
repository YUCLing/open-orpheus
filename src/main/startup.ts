import os from "node:os";
import path from "node:path";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";

import { app, dialog, protocol, session } from "electron";

import { onExit } from "@open-orpheus/lifecycle";

import { CORE_VERSION } from "@shared/constants";
import { toError } from "@shared/util";
import versions from "../../versions.json";
import { bootstrap } from "@main/bootstrap/context";
import { prepareDeviceId } from "@main/device";
import {
  data as dataDir,
  downloadTemp as downloadTempDir,
  lastWebpackHash as lastWebpackHashPath,
  streamerTemp as streamerTempDir,
} from "@main/folders";
import logger from "@main/logger";
import packManager, { NO_WEBPACK_ERROR_MESSAGE } from "@main/pack";
import {
  ensureWebPack,
  type WebPackLoadDeps,
  type WebPackProbe,
} from "@main/pack-loader";
import registerAsProtocolClient from "@main/protocol";
import { isFileNotFound } from "@main/util";
import showPackgeDownloadWindow from "@main/windows/package-download";

import type WebPack from "@main/packs/WebPack";
import type { ProxyConfiguration } from "@main/request";

/** The ordered start-up sequence; rejects if the app cannot come up. */
export async function startApplication() {
  // Make sure data directory exists
  await mkdir(path.join(dataDir), { recursive: true });

  const openOrpheusSession = await configureSessions();

  await ensureWebPack(createWebPackLoadDeps());

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
        if (url.protocol === "https:" || url.hostname.endsWith("music.163.com"))
          frame.executeJavaScript("window.channel = window.channel ?? {};");
      });
    });
  });

  // Initialize schemes and get registrars
  const [registerOrpheusScheme, registerAudioScheme] = await Promise.all([
    import("@main/orpheus").then((m) => m.default),
    import("@main/audio").then((m) => m.default),
  ]);

  // Register for default session
  registerOrpheusScheme(protocol);
  registerAudioScheme(protocol);

  // Register for Open Orpheus session
  registerOrpheusScheme(openOrpheusSession.protocol);

  const ctx = await bootstrap({ logger });

  await Promise.all([
    // Set temp dir for streamer and run cleanup
    import("@main/audio/OnlineStreamer").then(async (m) => {
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
    import("@main/afp"),
    import("@main/fonts"),
    import("@main/mediaSession").then((m) =>
      m.createMediaSession({ windows: ctx.windows })
    ),
    import("@main/channel"),
    import("@main/request").then(async (m) => {
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
      const proxy = await ctx.settings.kv.get("proxy");
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
      await (await import("@main/cookie")).default();
    }),
    packManager.getPack<WebPack>("web").readPack(),
    import("@main/windows/desktop-lyrics").then(async (m) => {
      // Create desktop lyrics window
      await m.default({
        windows: ctx.windows,
        lifecycle: ctx.lifecycle,
        settings: ctx.settings,
      });
    }),
    import("@main/windows/mini-player").then(async (m) => {
      // Create mini player window
      await m.default({
        windows: ctx.windows,
        lifecycle: ctx.lifecycle,
        settings: ctx.settings,
      });
    }),
  ]);

  // `cookie` reads `session.defaultSession` at module scope, so the concrete modules
  // the call handlers need are loaded here rather than imported statically.
  const [{ readEffect }, cookieModule, trayModule] = await Promise.all([
    import("@main/audio"),
    import("@main/cookie"),
    import("@main/tray"),
  ]);
  const { registerCallModules } = await import("@main/calls/index");

  const tray = trayModule.createTray({
    windows: ctx.windows,
    settings: ctx.settings,
  });

  registerCallModules({
    settings: ctx.settings,
    database: ctx.database,
    windows: ctx.windows,
    lifecycle: ctx.lifecycle,
    audio: { readEffect },
    cookie: {
      getCookies: cookieModule.getCookies,
      getFullCookies: cookieModule.getFullCookies,
      removeCookie: cookieModule.removeCookie,
      setCookie: cookieModule.setCookie,
    },
    tray,
  });

  onExit(() => {
    app.quit(); // Graceful exit
  });

  // Create main window
  await (
    await import("@main/windows/main")
  ).default({
    windows: ctx.windows,
    lifecycle: ctx.lifecycle,
  });

  // TODO: Maybe only do this on first launch?
  registerAsProtocolClient();

  import("@main/update").then((m) => m.checkUpdate());
}

async function configureSessions() {
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

  await import("@main/gui").then((m) => {
    // Register GUI scheme for Open Orpheus session now, package download window might need it
    m.default(openOrpheusSession.protocol);
  });

  return openOrpheusSession;
}

function createWebPackLoadDeps(): WebPackLoadDeps {
  return {
    logger,
    expectedCommit: versions.commit,
    argv: process.argv,

    readOfferedCommit: () =>
      readFile(lastWebpackHashPath, { encoding: "utf-8" })
        .then((content) => content.trim() || null)
        .catch((err) => {
          if (!isFileNotFound(err)) {
            logger.warn(
              { name: "loader", err: toError(err) },
              "Cannot read last web pack commit hash."
            );
          }
          return null;
        }),

    writeOfferedCommit: async (commit) => {
      await writeFile(lastWebpackHashPath, commit).catch((e) => {
        logger.warn(
          { name: "loader", err: toError(e) },
          "Cannot save current web pack commit hash."
        );
      });
    },

    probeWebPack: async (): Promise<WebPackProbe> => {
      try {
        await packManager.loadWebPack();
        const webPack = packManager.getPack<WebPack>("web");
        return { status: "ready", commit: await webPack.getCommitHash() };
      } catch (err) {
        logger.error(
          { name: "loader", err: toError(err) },
          "Failed to load web pack."
        );
        return err instanceof Error && err.message === NO_WEBPACK_ERROR_MESSAGE
          ? { status: "missing" }
          : { status: "failed" };
      }
    },

    requestDownload: (reason) => showPackgeDownloadWindow(reason),

    showDownloadFailure: (noUsablePack) => {
      dialog.showErrorBox(
        "Open Orpheus",
        noUsablePack
          ? "资源包下载失败"
          : "资源包下载失败\n可通过 Open Orpheus 管理界面重新尝试下载"
      );
    },

    restartWithout: (flag) => {
      app.relaunch({ args: process.argv.filter((v) => v !== flag) });
      app.quit();
    },

    exit: (code) => app.exit(code),
  };
}
