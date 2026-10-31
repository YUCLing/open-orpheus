import { screen, type BrowserWindow } from "electron";

export function getWindowScaleFactor(wnd: BrowserWindow): number {
  const bounds = wnd.getBounds();
  return screen.getDisplayMatching(bounds).scaleFactor;
}
