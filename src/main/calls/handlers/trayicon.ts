import { nativeImage } from "electron";

import { pngFromIco } from "../../platform/util";
import { loadFromOrpheusUrl } from "../../platform/orpheus";
import type { TrayService } from "../../services/tray";
import { registerCallHandler } from "../dispatcher";

export interface TrayiconDeps {
  tray: TrayService;
}

export function register(deps: TrayiconDeps): void {
  registerCallHandler<[string], void>(
    "trayicon.setIcon",
    async (event, iconUrl) => {
      const icon = await loadFromOrpheusUrl(iconUrl);
      const buf = pngFromIco(icon.content as unknown as Uint8Array);
      const image = nativeImage.createFromBuffer(Buffer.from(buf));
      deps.tray.setIcon(image);
    }
  );

  registerCallHandler<[string], void>(
    "trayicon.setToolTip",
    (event, tooltip) => {
      deps.tray.setTooltip(tooltip);
    }
  );

  registerCallHandler<[], [boolean]>("trayicon.wasInstall", () => {
    return [deps.tray.isInstalled()];
  });

  registerCallHandler<[], void>("trayicon.install", () => {
    deps.tray.install();
  });

  registerCallHandler<[], void>("trayicon.uninstall", () => {
    deps.tray.uninstall();
  });
}
