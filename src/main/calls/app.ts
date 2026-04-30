import os from "node:os";

import {
  app,
  BrowserWindow,
  dialog,
  nativeImage,
  ThumbarButton,
  WebContents,
} from "electron";

import { registerCallHandler } from "../calls";
import { loadFromOrpheusUrl } from "../orpheus";
import { pngFromIco } from "../util";
import packManager from "../pack";
import { stat } from "node:fs/promises";

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

registerCallHandler<[], [] | [{ movesrc: string; movedest: string }]>(
  "app.getAppStartCommand",
  () => {
    const moverunIdx = process.argv.indexOf("--moverun");
    if (moverunIdx !== -1 && process.argv.length > moverunIdx + 2) {
      const src = process.argv[moverunIdx + 1];
      const dest = process.argv[moverunIdx + 2];
      return [
        {
          movesrc: src,
          movedest: dest,
        },
      ];
    }
    return [];
  }
);

registerCallHandler<[string, string], [string]>(
  "app.getLocalConfig",
  (event, item, subItem) => {
    // TODO: Implement this properly
    switch (item) {
      case "Proxy":
        return [""]; // No Proxy
      case "setting":
        break;
      case "features":
        if (subItem === "hidpi") {
          // Do nothing?
        }
        break;
    }
    return [""];
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
    const buf = await pngFromIco(icon.content);
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
      properties: [
        "openFile",
        "openDirectory",
        "multiSelections",
        "dontAddToRecent",
      ],
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

registerCallHandler<
  [{ path: string; pathtype: string }],
  [boolean]
>("app.systemVoiceHint", () => {
  return [true];
});

registerCallHandler<[], [{ fullscreen: boolean; self: boolean }]>("app.isAppFulllScreen", (event) => {
  const wnd = BrowserWindow.fromWebContents(event.sender);
  return [{ fullscreen: wnd?.isFullScreen() ?? false, self: false }];
});
