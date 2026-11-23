/**
 * Shared packaging config: the single source of truth for the values the
 * makers and builders need that `package.json` does not already provide.
 *
 * The interfaces live in `tools/packaging/metadata.types.ts`.
 *
 * npm identity — `name`, `version`, `description`, `license`, `author` — stays
 * in `package.json`, which every builder already receives and falls back to.
 * Only overrides and gaps live here, so no format restates another's value.
 *
 * The desktop entry is deliberately *not* covered: its text is written as-is by
 * `tools/packaging/resources/open-orpheus.desktop.ejs`.
 */
import type { Metadata } from "../packaging/metadata.types.ts";

export const metadata: Metadata = {
  appId: "io.github.yucling.open-orpheus",
  homepage: "https://github.com/YUCLing/open-orpheus",
  summary: "An open-source Netease Cloud Music client",
  description:
    "An open-source Netease Cloud Music client\n" +
    "An open-source implementation of Netease Cloud Music's Orpheus browser host.",
  icons: {
    "256x256": "assets/icon_256.png",
    "512x512": "assets/icon_512.png",
    scalable: "assets/icon.svg",
  },
  squirrel: {
    name: "OpenOrpheus",
    title: "Open Orpheus",
    setupIcon: "assets/icon_256.ico",
  },
  flatpak: {
    runtimeVersion: "26.08",
    baseVersion: "26.08",
    finishArgs: [
      "--socket=wayland",
      "--socket=fallback-x11",
      "--share=ipc",
      "--device=dri",
      "--socket=pulseaudio",
      "--share=network",
      "--talk-name=org.kde.StatusNotifierWatcher",
      "--own-name=io.github.yucling.OpenOrpheus",
    ],
  },
};
