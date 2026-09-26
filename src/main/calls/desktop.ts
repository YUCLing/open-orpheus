import { isLayerShellAvailable } from "@open-orpheus/window";

import { registerCallHandler } from "../calls";
import MusicDesktopWindow from "../windows/music-desktop";

let musicDesktopWindow: MusicDesktopWindow | null = null;

// 乐评桌面支持
registerCallHandler<
  [],
  [
    {
      offscreen: boolean;
      support: boolean;
    },
  ]
>("desktop.support", () => [
  { offscreen: false, support: isLayerShellAvailable() },
]);

registerCallHandler<
  [
    {
      url: string;
      visible: boolean;
      deviceId: "";
    },
  ],
  void
>("desktop.create", (event, params) => {
  if (musicDesktopWindow) musicDesktopWindow.destroy();
  musicDesktopWindow = new MusicDesktopWindow(params.url);
  if (params.visible) musicDesktopWindow.show();
});

registerCallHandler<
  [
    {
      visible: boolean;
      deviceId: null;
    },
  ],
  void
>("desktop.show", (event, params) => {
  if (!musicDesktopWindow) return;
  if (params.visible) musicDesktopWindow.show();
  else musicDesktopWindow.hide();
});

registerCallHandler<[], void>("desktop.destroy", () => {
  if (!musicDesktopWindow) return;
  musicDesktopWindow.destroy();
  musicDesktopWindow = null;
});
