import { join } from "node:path";

import { screen } from "electron";
import {
  DesktopEnvironment,
  getDesktopEnvironment,
  LayerShellLayer,
  setWindowAsBackground,
} from "@open-orpheus/window";

import { ManagedWindow } from "./managedWindow";
import { isAppUrl } from "../platform/util";

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
        preload: join(import.meta.dirname, "preload.cjs"),
      },
    });
    if (isAppUrl(url)) {
      void wnd.loadURL(url);
    } else {
      LOGGER.warn({ url }, `refused to load a non-application URL into the music desktop window`);
    }
    this.setWindowInputRegion([]);

    if (
      [DesktopEnvironment.X11, DesktopEnvironment.Windows, DesktopEnvironment.Darwin].includes(
        getDesktopEnvironment()
      )
    ) {
      const setBounds = () => wnd.setBounds(screen.getPrimaryDisplay().bounds);
      setBounds();
      screen.addListener("display-added", setBounds);
      screen.addListener("display-metrics-changed", setBounds);
      screen.addListener("display-removed", setBounds);
      wnd.addListener("closed", () => {
        screen.removeListener("display-added", setBounds);
        screen.removeListener("display-metrics-changed", setBounds);
        screen.removeListener("display-removed", setBounds);
      });
      try {
        setWindowAsBackground(wnd.getNativeWindowHandle());
      } catch (e) {
        // Destroy the window and rethrow, deferred so attaching won't crash.
        setImmediate(() => this.destroy());
        throw e;
      }
    }
  }

  protected override beforeSurfaceCreated(): void {
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
