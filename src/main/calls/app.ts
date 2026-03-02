import {
  app,
  BrowserWindow,
  nativeImage,
  ThumbarButton,
  WebContents,
} from "electron";
import { registerCallHandler } from "../calls";
import { loadFromOrpheusUrl } from "../orpheus";
import { pngFromIco } from "../util";

registerCallHandler<string[], void>("app.log", (_ev, ...args) => {
  console.log(...args);
});

registerCallHandler<[], void>("app.exit", () => {
  app.quit();
});

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
