import { join } from "node:path";

import { screen } from "electron";
import type { UnsubscribeFunction } from "emittery";

import { ManagedWindow } from "../window";
import { isAppUrl } from "../util/url";
import { playbackController, playId } from "../mediaSession";

export default class DesktopPetWindow extends ManagedWindow {
  constructor(url: string, size?: { width: number; height: number }, topmost = true) {
    super();
    const wnd = this.createBrowserWindow({
      ...size,
      title: "Open Orpheus Desktop Pet",
      frame: false,
      hasShadow: false,
      skipTaskbar: true,
      transparent: true,
      alwaysOnTop: topmost,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        preload: join(import.meta.dirname, "preload.cjs"),
        additionalArguments: ["--preload-channel=pet"],
      },
    });
    // Blocking the page setting title of the window.
    wnd.prependListener("page-title-updated", (e) => e.preventDefault());
    wnd.on("will-move", () => {
      this.sendMouseEvent("dragstart");
    });
    wnd.on("moved", () => {
      this.sendMouseEvent("dragend");
    });

    let timeupdateUnsub: UnsubscribeFunction | null = null;
    wnd.on("show", () => {
      if (timeupdateUnsub) timeupdateUnsub();
      timeupdateUnsub = playbackController.on("timeupdate", ({ data }) => {
        if (wnd.isDestroyed()) return;
        wnd.webContents.send("channel.call", "audioplayer.onPlayProgress", playId, data, 1);
      });
    });
    wnd.on("hide", () => {
      if (timeupdateUnsub) timeupdateUnsub();
    });
    wnd.on("closed", () => {
      if (timeupdateUnsub) timeupdateUnsub();
    });

    if (isAppUrl(url)) {
      void wnd.loadURL(url);
    } else {
      LOGGER.warn({ url }, `refused to load a non-application URL into the desktop pet window`);
    }
  }

  private sendMouseEvent(
    type: "click" | "hover" | "hoverenter" | "hoverleave" | "dragstart" | "dragend",
    position?: { x?: number; y?: number; px?: number; py?: number }
  ) {
    if (!this.window) return;

    let { x, y, px, py } = position ?? {};

    const hasDip = x !== undefined && y !== undefined;
    const hasPhysical = px !== undefined && py !== undefined;

    if (!hasDip && !hasPhysical) {
      // Nothing provided → use cursor (DIP) and convert to physical pixels
      const cursor = screen.getCursorScreenPoint();
      const physical = screen.dipToScreenPoint(cursor);
      x = cursor.x;
      y = cursor.y;
      px = physical.x;
      py = physical.y;
    } else if (hasDip && !hasPhysical) {
      // DIP provided → derive physical pixels
      const physical = screen.dipToScreenPoint({ x: x!, y: y! });
      px = physical.x;
      py = physical.y;
    } else if (!hasDip && hasPhysical) {
      // Physical pixels provided → derive DIP
      const dip = screen.screenToDipPoint({ x: px!, y: py! });
      x = dip.x;
      y = dip.y;
    }

    this.window.webContents.send("channel.call", "desktoppet.onMouseEvent", { type, x, y, px, py });
  }
}
