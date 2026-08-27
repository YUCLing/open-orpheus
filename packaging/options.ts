import type { MakerSquirrelConfig } from "@electron-forge/maker-squirrel";
import type { MakerFlatpakConfig } from "@electron-forge/maker-flatpak";
import type { MakerAppImageConfigOptions } from "@reforged/maker-appimage";

import type { MakerDebOptions, MakerRpmOptions } from "./types.ts";

export const squirrel: MakerSquirrelConfig = {
  name: "OpenOrpheus",
  title: "Open Orpheus",
  description: "An open-source Netease Cloud Music client",
  authors: "YUCLing",
};

export const rpm: MakerRpmOptions = {
  name: "open-orpheus",
  description: "An open-source Netease Cloud Music client",
  license: "MIT",
  homepage: "https://github.com/YUCLing/open-orpheus",
  nodeps: true,
};

export const deb: MakerDebOptions = {
  name: "open-orpheus",
  nodeps: true,
  section: "sound",
  maintainer: "YUCLing <luotianyi@luotianyi.me>",
  homepage: "https://github.com/YUCLing/open-orpheus",
  description:
    "An open-source Netease Cloud Music client\n" +
    "An open-source implementation of Netease Cloud Music's Orpheus browser host.",
};

export const flatpak: MakerFlatpakConfig["options"] = {
  id: "io.github.yucling.open-orpheus",
  productName: "Open Orpheus",
  description: "An open-source Netease Cloud Music client",
  files: [
    [
      "assets/icon_256.png",
      "/share/icons/hicolor/256x256/apps/io.github.yucling.open-orpheus.png",
    ],
  ],
  icon: undefined,
  categories: ["AudioVideo", "Audio", "Network"],
  runtimeVersion: "25.08",
  baseVersion: "25.08",
  modules: [],
  finishArgs: [
    "--socket=wayland",
    "--socket=fallback-x11",
    "--share=ipc",
    "--device=dri",
    "--socket=pulseaudio",
    "--share=network",
    "--talk-name=org.kde.StatusNotifierWatcher",
  ],
};

export const AppImage: MakerAppImageConfigOptions = {
  name: "open-orpheus",
  productName: "Open Orpheus",
  icon: "assets/icon_256.png",
  categories: ["Audio", "AudioVideo", "Music", "Network"],
};
