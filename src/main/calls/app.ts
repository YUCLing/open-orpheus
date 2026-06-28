import os from "node:os";
import { rm, stat, writeFile } from "node:fs/promises";

import {
  app,
  BrowserWindow,
  dialog,
  nativeImage,
  ThumbarButton,
  WebContents,
} from "electron";

import { registerCallHandler, registerCallbackHandler } from "../calls";
import { loadFromOrpheusUrl } from "../orpheus";
import { fileExists, pngFromIco } from "../util";
import packManager from "../pack";
import { kv as settings } from "../settings";
import type { ProxyConfiguration, ProxyTypes } from "../request";
import { client, getProxyAgent } from "../request";
import { disableHardwareAccelerationFlag } from "../folders";
import { LifecycleState, setLifecycleState } from "../lifecycle";
import { DawnEntry, setStatisEndpoint, statisV2 } from "../dawn";

registerCallHandler<string[], void>("app.log", (_ev, ...args) => {
  console.log(...args);
});

registerCallHandler<["dawn", DawnEntry[]], void>(
  "app.statisV2",
  (event, type, data) => {
    statisV2(type, data);
  }
);

registerCallHandler<string[], void>("app.exit", (event, action, ...params) => {
  let args = process.argv.slice(1); // Skip the first argument which is the executable path

  const moverunIdx = args.indexOf("--moverun");
  if (moverunIdx !== -1) {
    // If --moverun is present, we need to drop it
    args = args.slice(0, moverunIdx).concat(args.slice(moverunIdx + 3));
  }

  if (action === "restart") {
    app.relaunch({ args });
  } else if (action === "moverun") {
    const src = params[0];
    const dest = params[1];
    app.relaunch({
      args: args.concat(["--moverun", src, dest]),
    });
  }

  app.quit();
});

type StartCommand =
  | { movesrc: string; movedest: string }
  | {
      webcmd: string;
    };
registerCallHandler<[], [] | [StartCommand]>("app.getAppStartCommand", () => {
  for (let i = 0; i < process.argv.length; i++) {
    const v = process.argv[i];
    if (v === "--moverun" && process.argv.length > i + 2) {
      const src = process.argv[i + 1];
      const dest = process.argv[i + 2];
      return [
        {
          movesrc: src,
          movedest: dest,
        },
      ];
    } else if (v.startsWith("orpheus://")) {
      return [
        {
          webcmd: v,
        },
      ];
    }
  }
  return [];
});

registerCallHandler<[string, string], [string]>(
  "app.getLocalConfig",
  async (event, item, subItem) => {
    // TODO: Implement this properly
    switch (item) {
      case "Proxy": {
        const proxyConf = await settings.get("proxy");
        if (typeof proxyConf !== "string") return [""];
        return [proxyConf];
      }
      case "setting":
        if (subItem === "hardware-acceleration") {
          return [
            (await fileExists(disableHardwareAccelerationFlag)) ? "0" : "1",
          ];
        }
        break;
    }
    return [""];
  }
);

registerCallHandler<[string, string, string], void>(
  "app.setLocalConfig",
  async (event, item, subItem, value) => {
    switch (item) {
      case "Proxy":
        await settings.set("proxy", value);
        return;
      case "setting":
        if (subItem === "hardware-acceleration") {
          if (value === "1") {
            // Enable hardware accel
            await rm(disableHardwareAccelerationFlag, { force: true });
          } else {
            // Disable hardware accel
            await writeFile(disableHardwareAccelerationFlag, "", {
              encoding: "utf-8",
            });
          }
        }
        return;
    }
  }
);

type Features = "hdpi";
type FeaturesSwitch = Partial<Record<Features, boolean>>;
registerCallHandler<[FeaturesSwitch], void>(
  "app.featuresSwitch",
  async (event, features) => {
    for (const feature in features) {
      const value = features[feature as Features];
      if (feature === "hdpi") {
        if (!value) {
          // Disable HiDPI, it's there for Chromium 91, but Chromium now doesn't
          // support disabling HiDPI
          const wnd = BrowserWindow.fromWebContents(event.sender);
          if (!wnd) return;
          dialog.showMessageBox(wnd, {
            title: "Open Orpheus",
            message: "十分抱歉，但 Open Orpheus 不支持禁用高分辨率支持。",
          });
        }
      }
    }
  }
);

type ThumbnailOptions = {
  btnExtends: Button[];
  btnLeft?: Button;
  btnRight?: Button;
  btnMiddle?: Button;
  defaultCover?: string;
  tooltip?: string;
};
const currentThumbnailOptions: ThumbnailOptions = { btnExtends: [] };
function createButtonFactory(
  webContents: WebContents
): (btn: Button) => Promise<ThumbarButton> {
  return async (btn: Button) => {
    const icon = await loadFromOrpheusUrl(btn.url);
    const buf = pngFromIco(icon.content as unknown as Uint8Array);
    return {
      tooltip: btn.tooltip,
      icon: nativeImage.createFromBuffer(Buffer.from(buf)),
      click() {
        webContents.send("channel.call", "player.onthumbnailaction", btn.id);
      },
    };
  };
}
type Button = {
  id: number;
  tooltip: string;
  url: string;
};
registerCallHandler<[ThumbnailOptions], void>(
  "app.setThumbnail",
  async (event, options) => {
    if (os.platform() !== "win32") {
      // Thumbnail buttons are only supported on Windows, ignore on other platforms
      return;
    }
    const mainWindow = BrowserWindow.fromWebContents(event.sender);
    if (!mainWindow) return;
    {
      const {
        btnExtends,
        btnLeft,
        btnRight,
        btnMiddle,
        defaultCover,
        tooltip,
      } = options;
      currentThumbnailOptions.btnExtends = btnExtends;
      currentThumbnailOptions.btnLeft =
        btnLeft || currentThumbnailOptions.btnLeft;
      currentThumbnailOptions.btnRight =
        btnRight || currentThumbnailOptions.btnRight;
      currentThumbnailOptions.btnMiddle =
        btnMiddle || currentThumbnailOptions.btnMiddle;
      currentThumbnailOptions.defaultCover =
        defaultCover || currentThumbnailOptions.defaultCover;
      currentThumbnailOptions.tooltip =
        tooltip || currentThumbnailOptions.tooltip;
    }

    const { btnExtends, btnLeft, btnRight, btnMiddle, tooltip } =
      currentThumbnailOptions;

    const btns = [];
    if (btnLeft) {
      btns.push(btnLeft);
    }
    if (btnMiddle) {
      btns.push(btnMiddle);
    }
    if (btnRight) {
      btns.push(btnRight);
    }
    btns.push(...btnExtends);
    mainWindow.setThumbnailToolTip(tooltip || "");

    mainWindow.setThumbarButtons(
      await Promise.all(btns.map(createButtonFactory(mainWindow.webContents)))
    );
  }
);

registerCallHandler<
  [
    {
      dawn: string;
      discern: string;
      discern_uri: string;
      e_batch_url: string;
      e_url: string;
      fixdiscern: string;
      fixdiscern_uri: string;
      hostgroup1: string[];
      hostgroup2: string[];
      hostgroup3: string[];
      hostgroup4: string[];
      lyric: string;
      mam: string;
      monitor: string;
      nsinfo: string;
      refer: string;
      statis: string;
    },
  ],
  [boolean]
>("app.initUrls", (event, urls) => {
  setStatisEndpoint(urls.dawn, urls.refer);
  return [true];
});

registerCallHandler<[string, string], [boolean]>(
  "app.loadSkinPackets",
  async (event, name, name2) => {
    try {
      await packManager.loadSkinPack(name, name2);
      return [true];
    } catch (e) {
      console.error("Failed to load skin pack", e);
    }
    return [false];
  }
);

registerCallHandler<
  [
    {
      patchVersion: string;
    },
  ],
  void
>("app.onBootFinish", async () => {
  /* empty */
});
registerCallHandler<[], void>("app.appStartUpEnd", () => {
  setLifecycleState(LifecycleState.Started);
});

registerCallHandler<[], [boolean]>("app.isRegisterDefaultClient", () => [
  false,
]);

registerCallHandler<[], void>("app.getDefaultMusicPlayPath", () => {
  return;
});

registerCallHandler<[string], void>("app.login", (event, uid) => {
  if (uid) {
    // Logged in
  } else {
    // Logged out
  }
});

registerCallHandler<
  [
    {
      userid: string;
      isVip: undefined;
      isSVip: undefined;
      vipLevel: undefined;
      svipLevel: undefined;
    },
  ],
  void
>("app.setCustomInfo", (event, info) => {
  if (info.userid) {
    // Logged in
  } else {
    // Logged out
  }
});

registerCallHandler<[string, string, "", string], void>(
  "app.selectSystemFileAndDir",
  async (event, taskId, title, emptyStr, accept) => {
    const wnd = BrowserWindow.fromWebContents(event.sender);
    if (!wnd) return;
    let props: Electron.OpenDialogOptions["properties"] = [];
    if (os.platform() !== "darwin") {
      // On Windows/Linux, `openFile` and `openDirectory` cannot be used at the same time.
      const res = await dialog.showMessageBox(wnd, {
        title,
        message: "你想选择文件夹还是文件？",
        type: "question",
        buttons: ["文件夹", "文件"],
      });
      if (res.response === 0) {
        props = ["openDirectory"];
      } else if (res.response === 1) {
        props = ["openFile"];
      }
    } else {
      props = ["openDirectory", "openFile"];
    }
    const filters = accept
      .split("\0\0")
      .flatMap((item) => (!item ? [] : [item.split("\0")]))
      .map(([name, extensions]) => ({
        name,
        extensions: extensions
          .split(";")
          .map((ext) => (ext === "*" ? ext : ext.replace(/^\*\./, ""))),
      }));
    const result = await dialog.showOpenDialog(wnd, {
      title,
      properties: [...props, "multiSelections", "dontAddToRecent"],
      filters,
    });
    if (result.canceled) {
      event.sender.send(
        "channel.call",
        "app.onSelectFileAndDir",
        false,
        taskId
      );
      return;
    }
    const items: { isDir: boolean; path: string }[] = [];
    await Promise.allSettled(
      result.filePaths.map(async (filePath) => {
        const statResult = await stat(filePath);
        items.push({ isDir: statResult.isDirectory(), path: filePath });
      })
    );
    event.sender.send(
      "channel.call",
      "app.onSelectFileAndDir",
      true,
      taskId,
      items
    );
  }
);

registerCallHandler<[string, string, "", string], void>(
  "app.selectSystemDir",
  async (event, taskId, title, emptyStr, currentDir) => {
    const wnd = BrowserWindow.fromWebContents(event.sender);
    if (!wnd) return;
    const result = await dialog.showOpenDialog(wnd, {
      title,
      defaultPath: currentDir,
      properties: ["openDirectory", "dontAddToRecent", "createDirectory"],
    });
    if (result.canceled) {
      event.sender.send("channel.call", "app.onSelectDir", false, taskId);
      return;
    }
    event.sender.send(
      "channel.call",
      "app.onselectsystemfile",
      true,
      taskId,
      result.filePaths[0]
    );
  }
);

registerCallHandler<[], [{ fullscreen: boolean; self: boolean }]>(
  "app.isAppFulllScreen",
  (event) => {
    const wnd = BrowserWindow.fromWebContents(event.sender);
    return [{ fullscreen: wnd?.isFullScreen() ?? false, self: false }];
  }
);

registerCallbackHandler<
  [
    | {
        type: "question";
        appinfo: string;
        desc: string;
        subDesc: string;
        avatarUrl: string;
        yes: string;
        no: string;
        userdata: string;
      }
    | {
        type: "immersive_push_notify";
        priority: "queue"; // TODO: To be expanded
        userdata: string; // JSON string
        btn_1_content: string; // "查看详情 >"
        btn_2_content: string; // "一键播放"
        free_audition: boolean;
        menu: string; // AppMenu
        title: string;
        cover: string; // Image URL
        desc: string;
        push_icon_small: "";
        push_icon_big: "";
        daytime_formatpath: string; // "orpheus://orpheus/pub/public/assets/svg/home-page/date-%d.svg"
        songs: {
          songName: string;
          songCover: string;
          artist: string;
        }[];
      },
  ]
>("app.systemUIHint", (callback, event, params) => {
  if (params.type !== "question") {
    callback(false);
    return;
  }

  const wnd = BrowserWindow.fromWebContents(event.sender);
  if (!wnd) {
    callback(false);
    return;
  }

  wnd.focus();
  wnd.show();

  const timeout = setTimeout(() => {
    callback({ action: "no", userdata: params.userdata });
  }, 30000);

  dialog
    .showMessageBox(wnd, {
      type: "question",
      title: params.appinfo,
      message: params.desc,
      detail: params.subDesc,
      buttons: [params.yes, params.no],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    .then((result) => {
      clearTimeout(timeout);
      callback({
        action: result.response === 0 ? "yes" : "no",
        userdata: params.userdata,
      });
    })
    .catch(() => {
      clearTimeout(timeout);
      callback({ action: "no", userdata: params.userdata });
    });
});

registerCallHandler<[number, ProxyTypes, string, string, string, string], void>(
  "app.testProxy",
  (event, taskId, type, address, username, password, url) => {
    (async () => {
      const cfg: ProxyConfiguration = {
        Type: type,
      };
      const addr = address.split(":");
      const host = addr[0];
      const port = addr[1];
      cfg[type] = {
        Host: host,
        Port: port,
        UserName: username,
        Password: password,
      };
      const agent = await getProxyAgent(cfg);
      try {
        const req = await client(url, {
          agent,
          throwHttpErrors: false,
        });
        event.sender.send(
          "channel.call",
          "app.ontestproxy",
          taskId,
          req.ok ? 0 : 7
        );
      } catch {
        event.sender.send("channel.call", "app.ontestproxy", taskId, 7);
      }
    })();
  }
);

registerCallHandler<[], [string]>("app.getAppStartType", () => {
  for (const arg of process.argv) {
    if (arg.startsWith("--orpheus-startup=")) {
      return [arg.substring(18)];
    }
  }
  return [""];
});

const AUTORUN_ARGS = ["--orpheus-startup=autorun"];
registerCallHandler<[string], [boolean]>(
  "app.getAutoRunState",
  (event, appName) => {
    if (os.platform() === "linux") {
      // Not supported on Linux
      return [false];
    }
    switch (appName) {
      case "cloudmusic": {
        const result = app.getLoginItemSettings({
          args: AUTORUN_ARGS,
        });
        return [result.openAtLogin];
      }
      default:
        console.warn("Unsupported app", appName, "for getting autorun");
        return [false];
    }
  }
);

registerCallHandler<[string, "autorun"], [boolean]>(
  "app.setAutoRun",
  (event, appName) => {
    switch (appName) {
      case "cloudmusic": {
        if (os.platform() === "linux") {
          // Not supported on Linux，show a dialog to provide
          // information on enabling main program's autorun
          // here for Linux users
          const wnd = BrowserWindow.fromWebContents(event.sender);
          if (wnd)
            dialog.showMessageBox(wnd, {
              message:
                "暂不支持在 Linux 上设置自动启动。\n\n如有需要可根据系统自行设置并附加参数：" +
                AUTORUN_ARGS.join(" "),
              title: "Open Orpheus",
              type: "warning",
            });
          return [false];
        }
        app.setLoginItemSettings({
          openAtLogin: true,
          enabled: true,
          args: AUTORUN_ARGS,
        });
        return [true];
      }
      default:
        console.warn("Unsupported app", appName, "for setting autorun");
        return [false];
    }
  }
);

registerCallHandler<[string], [boolean]>(
  "app.cancelAutoRun",
  (event, appName) => {
    if (os.platform() === "linux") {
      // Not supported on Linux
      return [false];
    }
    switch (appName) {
      case "cloudmusic": {
        app.setLoginItemSettings({
          openAtLogin: false,
          enabled: false,
          args: AUTORUN_ARGS,
        });
        return [true];
      }
      default:
        console.warn("Unsupported app", appName, "for cancelling autorun");
        return [false];
    }
  }
);
