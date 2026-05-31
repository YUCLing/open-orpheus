import os from "node:os";

import { Menu, MenuItem, nativeImage } from "electron";

import { pngFromIco } from "../util";
import { loadFromOrpheusUrl } from "../orpheus";
import { get, install, setIcon, setMenu, setTooltip, uninstall } from "../tray";
import { registerCallHandler } from "../calls";
import * as settings from "../settings";
import { mainWindow } from "../window";

if (os.platform() === "linux") {
  function onClickBehaviorUpdate(value: unknown) {
    if (value === "with-native-menu") {
      const menu = new Menu();
      menu.append(
        new MenuItem({
          label: "显示菜单",
          click: () => {
            mainWindow?.webContents.send(
              "channel.call",
              "trayicon.onrightclick"
            );
          },
        })
      );
      setMenu(menu);
    } else {
      setMenu(null);
    }
  }
  settings.events.on("change", (event) => {
    const { key, value } = event.data;
    if (key === "tray.clickBehavior") {
      onClickBehaviorUpdate(value);
    }
  });
  settings.kv
    .get("tray.clickBehavior")
    .then((v) => onClickBehaviorUpdate(v))
    .catch(console.error);
}

registerCallHandler<[string], void>(
  "trayicon.setIcon",
  async (event, iconUrl) => {
    const icon = await loadFromOrpheusUrl(iconUrl);
    const buf = pngFromIco(icon.content);
    const image = nativeImage.createFromBuffer(Buffer.from(buf));
    setIcon(image);
  }
);

registerCallHandler<[string], void>("trayicon.setToolTip", (event, tooltip) => {
  setTooltip(tooltip);
});

registerCallHandler<[], [boolean]>("trayicon.wasInstall", () => {
  return [get() !== null];
});

registerCallHandler<[], void>("trayicon.install", () => {
  install();
});

registerCallHandler<[], void>("trayicon.uninstall", () => {
  uninstall();
});
