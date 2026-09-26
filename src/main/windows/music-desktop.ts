import { join } from "node:path";

import { LayerShellLayer } from "@open-orpheus/window";

import { ManagedWindow } from "../window";

export default class MusicDesktopWindow extends ManagedWindow {
  constructor(url: string) {
    super();
    const wnd = this.createBrowserWindow({
      title: "Open Orpheus Music Desktop",
      frame: false,
      resizable: false,
      roundedCorners: false,
      hasShadow: false,
      skipTaskbar: true,
      movable: false,
      transparent: true,
      show: false,
      webPreferences: {
        preload: join(import.meta.dirname, "preload.js"),
      },
    });
    wnd.loadURL(url);
    this.setWindowInputRegion([]);
  }

  protected beforeSurfaceCreated(): void {
    this.setLayerShell({
      namespace: "Open Orpheus Music Desktop",
      layer: LayerShellLayer.Background,
      anchorBottom: true,
      anchorLeft: true,
      anchorRight: true,
      anchorTop: true,
      marginBottom: 0,
      marginLeft: 0,
      marginRight: 0,
      marginTop: 0,
      exclusiveZone: -1,
    });
  }
}
