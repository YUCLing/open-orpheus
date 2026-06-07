import { nativeImage } from "electron";

import { pngFromIco } from "../util";
import { loadFromOrpheusUrl } from "../orpheus";
import {
  install,
  setIcon,
  setTooltip,
  trayInstalled,
  uninstall,
} from "../tray";
import { registerCallHandler } from "../calls";

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
  return [trayInstalled];
});

registerCallHandler<[], void>("trayicon.install", () => {
  install();
});

registerCallHandler<[], void>("trayicon.uninstall", () => {
  uninstall();
});
