import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerFlatpak } from "@electron-forge/maker-flatpak";
import { MakerAppImage } from "@reforged/maker-appimage";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives"; // TODO: Remove in Electron Forge 8

import * as options from "./packaging/options";

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      unpack: "**/*.{so*,dylib,dll}",
    },
    derefSymlinks: true, // TODO: Remove in Electron Forge 8

    // In offline environments (e.g. flatpak sandbox), SHASUMS256.txt cannot be
    // downloaded from GitHub. The electron zip is already verified by sha256 in
    // generated-node-sources.json, so it's safe to skip checksum verification.
    ...(process.env.ELECTRON_OFFLINE_BUILD
      ? { download: { unsafelyDisableChecksums: true } }
      : {}),

    // Override Vite Plugin's preferences, and with our preferences
    ignore: (file: string) => {
      if (!file) return false;

      return (
        file.startsWith("/node_modules/.") ||
        file.startsWith("/node_modules/electron/") ||
        file.startsWith("/node_modules/electron-nightly/") ||
        (!file.startsWith("/package.json") &&
          !file.startsWith("/.vite") &&
          !file.startsWith("/node_modules"))
      );
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel(options.squirrel),
    new MakerZIP({}, ["darwin"]),
    new MakerRpm({
      options: options.rpm,
    }),
    new MakerDeb({
      options: options.deb,
    }),
    new MakerFlatpak({
      options: options.flatpak,
    }),
    new MakerAppImage({
      options: options.AppImage,
    }),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: "src/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
        {
          entry: "src/windows/manage.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
        {
          entry: "src/windows/package-download.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
        {
          entry: "src/windows/desktop-lyrics.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
        {
          entry: "src/windows/desktop-lyrics-preview.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
        {
          entry: "src/windows/mini-player.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
        {
          entry: "src/windows/menu.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
        {
          entry: "src/worklets/pcm-honeypot.ts",
          config: "vite.worklets.config.ts",
          target: "preload",
        },
        {
          entry: "src/worklets/music-recorder.ts",
          config: "vite.worklets.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "gui",
          config: "vite.renderer.config.ts",
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    }),
  ],
};

export default config;
