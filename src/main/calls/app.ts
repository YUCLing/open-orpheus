import os from "node:os";
import { rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

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
import { pngFromIco } from "../util";
import packManager from "../pack";
import { kv as settings } from "../settings";
import type { ProxyConfiguration, ProxyTypes } from "../request";
import client, { getProxyAgent } from "../request";
import { disableHardwareAccelerationFlag } from "../folders";

registerCallHandler<string[], void>("app.log", (_ev, ...args) => {
  console.log(...args);
});

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
          return [existsSync(disableHardwareAccelerationFlag) ? "0" : "1"];
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
    const buf = pngFromIco(icon.content);
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
  /* empty */
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
    {
      type: "question";
      appinfo: string;
      desc: string;
      subDesc: string;
      avatarUrl: string;
      yes: string;
      no: string;
      userdata: string;
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
