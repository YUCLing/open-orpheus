import type { BrowserWindow } from "electron";

import type { MainWindowAccessor, WindowService } from "../bootstrap/types";

export let mainWindow: BrowserWindow | null = null;

export function setMainWindow(wnd: BrowserWindow | null) {
  mainWindow = wnd;
}

export const mainWindowAccessor: MainWindowAccessor = {
  current: () => mainWindow,
};

export const windowService: WindowService = {
  current: () => mainWindow,
  currentWindow: () => mainWindow,
  setMainWindow,
};
