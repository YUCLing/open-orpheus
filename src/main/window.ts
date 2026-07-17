import os from "node:os";

import { app, BrowserWindow, shell } from "electron";

import {
  getDesktopEnvironment,
  setInputRegion,
  DesktopEnvironment,
} from "@open-orpheus/window";

import AppMenu from "./menu";

type WindowProperties = {
  id?: string;
  maximumSize?: { x: number; y: number };
  minimumSize?: { x: number; y: number };
  menus: Record<number, AppMenu>;
  customProps: Record<string, unknown>;
};

export let mainWindow: BrowserWindow | null = null;

export function setMainWindow(wnd: BrowserWindow) {
  mainWindow = wnd;
}

const windowProperties = new Map<number, WindowProperties>();

function shouldRespectSizeConstraints(wnd: BrowserWindow) {
  return !wnd.isMaximized() && !wnd.isFullScreen();
}

function enableSizeConstraints(wnd: BrowserWindow) {
  const props = windowProperties.get(wnd.id);
  if (props?.maximumSize) {
    wnd.setMaximumSize(props.maximumSize.x, props.maximumSize.y);
  }
  if (props?.minimumSize) {
    wnd.setMinimumSize(props.minimumSize.x, props.minimumSize.y);
  }
}

function disableSizeConstraints(wnd: BrowserWindow) {
  const props = windowProperties.get(wnd.id);
  if (props?.maximumSize) {
    wnd.setMaximumSize(0, 0);
  }
  if (props?.minimumSize) {
    wnd.setMinimumSize(0, 0);
  }
}

app.on("browser-window-created", (event, wnd) => {
  windowProperties.set(wnd.id, {
    menus: Object.create(null),
    customProps: {},
  });
  wnd.on("closed", () => {
    windowProperties.delete(wnd.id);
  });

  wnd.on("maximize", () => {
    disableSizeConstraints(wnd);
  });

  wnd.on("unmaximize", () => {
    enableSizeConstraints(wnd);
  });

  wnd.on("enter-full-screen", () => {
    disableSizeConstraints(wnd);
  });

  wnd.on("leave-full-screen", () => {
    enableSizeConstraints(wnd);
  });

  if (getDesktopEnvironment() === DesktopEnvironment.Wayland) {
    // On Wayland, windows are actually not preserved across show / hide,
    // we will be setting their custom IDs each time they show
    wnd.on("show", () => {
      const originalTitle = wnd.title;
      wnd.setTitle("\u200B\u200C" + wnd.id);
      // Chromium/Electron store the title internally, we will be resetting the title,
      // thus Electron can remember the correct title.
      wnd.setTitle(originalTitle);
    });
  }

  wnd.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });
});

// Web pack identify windows by a custom string id.
export function setWindowId(wnd: BrowserWindow, id: string) {
  const props = windowProperties.get(wnd.id);
  if (props) {
    props.id = id;
  }
}

export function getWindowId(wnd: BrowserWindow): string | undefined {
  const props = windowProperties.get(wnd.id);
  return props ? props.id : undefined;
}

export function getWindowById(id: string): BrowserWindow | undefined {
  for (const [wndId, props] of windowProperties.entries()) {
    if (props.id === id) {
      return BrowserWindow.fromId(wndId) || undefined;
    }
  }
  return undefined;
}

export function setMaximumSize(wnd: BrowserWindow, x: number, y: number) {
  x = Math.round(x);
  y = Math.round(y);
  if (shouldRespectSizeConstraints(wnd)) {
    wnd.setMaximumSize(x, y);
  }
  const props = windowProperties.get(wnd.id);
  if (props) {
    props.maximumSize = { x, y };
  }
}

export function setMinimumSize(wnd: BrowserWindow, x: number, y: number) {
  x = Math.round(x);
  y = Math.round(y);
  if (shouldRespectSizeConstraints(wnd)) {
    wnd.setMinimumSize(x, y);
  }
  const props = windowProperties.get(wnd.id);
  if (props) {
    props.minimumSize = { x, y };
  }
}

export function getMenus(wnd: BrowserWindow): Record<number, AppMenu> {
  const props = windowProperties.get(wnd.id);
  return props ? props.menus : Object.create(null);
}

export function setWindowProp<T>(wnd: BrowserWindow, prop: string, value: T) {
  const customProps = windowProperties.get(wnd.id)?.customProps;
  if (!customProps) return; // Should not happen since we initialize it when creating the window
  customProps[prop] = value;
}

export function getWindowProp<T>(
  wnd: BrowserWindow,
  prop: string
): T | undefined {
  const customProps = windowProperties.get(wnd.id)?.customProps;
  if (!customProps) return undefined;
  return customProps[prop] as T;
}

export function removeWindowProp(wnd: BrowserWindow, prop: string) {
  const customProps = windowProperties.get(wnd.id)?.customProps;
  if (!customProps) return;
  delete customProps[prop];
}

export interface InputRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Sets window's input region
 *
 * Only available on Linux, for Windows and macOS, use Electron's `BrowserWindow.setIgnoreMouseEvent`.
 * @param wnd
 * @param regions
 * @returns
 */
export function setWindowInputRegion(
  wnd: BrowserWindow,
  regions: InputRegion[]
): boolean {
  if (os.platform() !== "linux") return false;
  const inputRegions =
    regions.length > 0
      ? regions.map((v) => ({ x: v.x, y: v.y, w: v.width, h: v.height }))
      : null;
  const doSetRegion = () => {
    if (getDesktopEnvironment() === DesktopEnvironment.Wayland) {
      return setInputRegion(wnd.id.toString(), inputRegions);
    } else {
      return setInputRegion(wnd.getNativeWindowHandle(), inputRegions);
    }
  };

  if (inputRegions) {
    const previousListener = getWindowProp<() => void>(
      wnd,
      "inputRegionShowListener"
    );
    if (previousListener) {
      wnd.removeListener("show", previousListener);
    }
    setWindowProp(wnd, "inputRegionShowListener", doSetRegion);
    wnd.addListener("show", doSetRegion);
  } else {
    const listener = getWindowProp<() => void>(wnd, "inputRegionShowListener");
    if (!listener) return false;
    wnd.removeListener("show", listener);
    removeWindowProp(wnd, "inputRegionShowListener");
  }

  return doSetRegion();
}
