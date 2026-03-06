import { BrowserWindow } from "electron";

type WindowProperties = {
  maximumSize?: { x: number; y: number };
};

const windowProperties = new Map<BrowserWindow, WindowProperties>();

export function addWindow(wnd: BrowserWindow) {
  windowProperties.set(wnd, {});
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
}

export function setMaximumSize(wnd: BrowserWindow, x: number, y: number) {
  if (wnd.isMaximized()) {
    wnd.setMaximumSize(x, y);
  }
  const props = windowProperties.get(wnd);
  if (props) {
    props.maximumSize = { x, y };
  }
}
