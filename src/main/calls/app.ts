import {
  app,
  BrowserWindow,
  nativeImage,
  ThumbarButton,
  WebContents,
} from "electron";

import { isWayland } from "@open-orpheus/window";

import { registerCallHandler } from "../calls";
import { loadFromOrpheusUrl } from "../orpheus";
import { pngFromIco } from "../util";
import os from "node:os";
import { loadSkinPack } from "../pack";
import { getApp } from "../ui";

registerCallHandler<string[], void>("app.log", (_ev, ...args) => {
  console.log(...args);
});

registerCallHandler<[], void>("app.exit", () => {
  app.quit();
});

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
  async (event, name) => {
    try {
      await loadSkinPack(name);
      if (os.platform() === "linux" && isWayland()) {
        await getApp().loadSkin("/menu/skin.xml");
      }
      return [true];
    } catch (e) {
      console.error("Failed to load skin pack", e);
      return [false];
    }
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
