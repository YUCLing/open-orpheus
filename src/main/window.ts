import { app, BrowserWindow, shell } from "electron";
import { AppMenu } from "./menu";

type WindowProperties = {
  maximumSize?: { x: number; y: number };
  menus: AppMenu[];
  customProps: Record<string, unknown>;
};

const windowProperties = new Map<BrowserWindow, WindowProperties>();

app.on("browser-window-created", (event, wnd) => {
  windowProperties.set(wnd, {
    menus: [],
    customProps: {},
  });
  wnd.on("closed", () => {
    windowProperties.delete(wnd);
  });

  wnd.on("maximize", () => {
    wnd.setMaximumSize(0, 0);
  });

  wnd.on("unmaximize", () => {
    const props = windowProperties.get(wnd);
    if (props?.maximumSize) {
      wnd.setMaximumSize(props.maximumSize.x, props.maximumSize.y);
    }
  });

  wnd.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });
});

export function setMaximumSize(wnd: BrowserWindow, x: number, y: number) {
  if (wnd.isMaximized()) {
    wnd.setMaximumSize(x, y);
  }
  const props = windowProperties.get(wnd);
  if (props) {
    props.maximumSize = { x, y };
  }
}

export function getMenus(wnd: BrowserWindow): AppMenu[] {
  const props = windowProperties.get(wnd);
  return props ? props.menus : [];
}

export function setWindowProp<T>(wnd: BrowserWindow, prop: string, value: T) {
  const customProps = windowProperties.get(wnd).customProps;
  customProps[prop] = value;
}

export function getWindowProp<T>(wnd: BrowserWindow, prop: string): T {
  const customProps = windowProperties.get(wnd).customProps;
  return customProps[prop] as T;
}
