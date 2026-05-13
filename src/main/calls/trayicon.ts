import os from "node:os";

import { Menu, MenuItem, nativeImage } from "electron";

import { pngFromIco } from "../util";
import { loadFromOrpheusUrl } from "../orpheus";
import { get, install, setIcon, setMenu, setTooltip, uninstall } from "../tray";
import { registerCallHandler } from "../calls";
import { addEventListener as addKVEventListener, KvChangeEvent } from "../kv";
import { mainWindow } from "../window";

if (os.platform() === "linux") {
  addKVEventListener("change", ((event: KvChangeEvent) => {
    const { key, current: value } = event.detail;
    if (key === "tray.clickBehavior") {
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
        // 切换Gnome菜单，设置占位符菜单建立 D-Bus 通道，然后触发渲染进程加载完整菜单
      } else if (value === "with-native-menu-gnome") {
        const placeholder = Menu.buildFromTemplate([
          { label: "加载中...", enabled: false },
        ]);
        setMenu(placeholder);
        if (mainWindow) {
          mainWindow.webContents.send("channel.call", "trayicon.onrightclick");
        }
      } else {
        setMenu(null);
      }
    }
  }) as EventListener);
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
