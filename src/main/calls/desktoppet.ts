import { BrowserWindow } from "electron";

import { AppMenuItem } from "$sharedTypes/menu";
import { registerCallHandler } from "../calls";
import { isAppUrl } from "../util/url";
import DesktopPetWindow from "../windows/desktop-pet";
import { ManagedWindow } from "../window";
import AppMenu from "../menu";

let desktopPetWindow: DesktopPetWindow | null = null;

registerCallHandler<
  [
    {
      background_color: number;
      width: number;
      height: number;
      topmost: boolean;
      url: string;
    },
  ],
  void
>("desktoppet.create", (event, params) => {
  if (!isAppUrl(params.url)) {
    LOGGER.warn({ url: params.url }, "refused to create the desktop pet window for url");
    return;
  }
  if (desktopPetWindow) {
    desktopPetWindow.destroy();
    desktopPetWindow.releaseNativeState();
  }
  desktopPetWindow = new DesktopPetWindow(
    params.url,
    { width: params.width, height: params.height },
    params.topmost
  );
  LOGGER.info("Desktop pet window created");
});

registerCallHandler<[], void>("desktoppet.show", async () => {
  if (!desktopPetWindow) return;
  await desktopPetWindow.show();
});

registerCallHandler<[], void>("desktoppet.hide", async () => {
  if (!desktopPetWindow) return;
  await desktopPetWindow.hide();
});

registerCallHandler<[], void>("desktoppet.destroy", async () => {
  if (!desktopPetWindow) return;
  desktopPetWindow.destroy();
});

registerCallHandler<
  [
    {
      content: AppMenuItem[];
    },
  ],
  void
>("desktoppet.popupMenu", async (event, param) => {
  const wnd = BrowserWindow.fromWebContents(event.sender);
  if (!wnd) return;
  const managed = ManagedWindow.fromBrowserWindow(wnd);
  if (!managed) return;
  const onClick = (itemId: string | null) => {
    if (event.sender.isDestroyed()) return;
    event.sender.send("channel.call", "winhelper.onmenuclick", itemId, 0);
  };
  const menu = new AppMenu(param.content);
  managed.setMenu(menu);
  menu.setClickHandler(onClick);
  await menu.show(wnd);
});

registerCallHandler<
  [],
  [
    {
      x: number;
      y: number;
      width: number;
      height: number;
    },
  ]
>("desktoppet.getBounds", () => {
  if (!desktopPetWindow?.window) return [{ x: 0, y: 0, width: 0, height: 0 }];
  return [desktopPetWindow.window.getBounds()];
});

registerCallHandler<
  [
    {
      width: number;
      height: number;
    },
  ],
  void
>("desktoppet.resize", (event, size) => {
  const wnd = BrowserWindow.fromWebContents(event.sender);
  if (!wnd) return;
  wnd.setSize(size.width, size.height);
});
