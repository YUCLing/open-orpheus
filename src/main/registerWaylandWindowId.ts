import { BrowserWindow } from "electron";

import {
  DesktopEnvironment,
  getDesktopEnvironment,
} from "@open-orpheus/window";

/** Register the BrowserWindow's stable Electron id with the Wayland tracker. */
export function registerWaylandWindowId(wnd: BrowserWindow) {
  const desktopEnvironment = getDesktopEnvironment();
  if (wnd.isDestroyed() || desktopEnvironment !== DesktopEnvironment.Wayland) {
    return;
  }
  const originalTitle = wnd.title;
  wnd.setTitle("\u200B\u200C" + wnd.id);
  wnd.setTitle(originalTitle);
}
