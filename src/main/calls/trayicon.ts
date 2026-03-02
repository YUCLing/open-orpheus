import { pngFromIco } from "../util";
import { loadFromOrpheusUrl } from "../orpheus";
import { get, install, setIcon, setTooltip, uninstall } from "../tray";
import { registerCallHandler } from "../calls";
import { nativeImage } from "electron";

registerCallHandler<[string], void>(
  "trayicon.setIcon",
  async (event, iconUrl) => {
    const icon = await loadFromOrpheusUrl(iconUrl);
    const buf = await pngFromIco(icon.content);
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
