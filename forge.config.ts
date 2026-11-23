import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

import pkg from "./package.json" with { type: "json" };
import { metadata } from "./tools/config/packaging.ts";

import MakerAppImage from "./tools/forge/makers/MakerAppImage.ts";
import MakerDeb from "./tools/forge/makers/MakerDeb.ts";
import MakerFlatpak from "./tools/forge/makers/MakerFlatpak.ts";
import MakerRpm from "./tools/forge/makers/MakerRpm.ts";
import { copyBuiltinPlugins } from "./tools/forge/hooks/builtin-plugins.ts";
import { deployDependencies, restoreDependencies } from "./tools/forge/hooks/deploy-deps.ts";
import { extractLicenses } from "./tools/forge/hooks/licenses.ts";
import { pruneLocales } from "./tools/forge/hooks/locales.ts";
import { replaceIcuData } from "./tools/forge/hooks/icu.ts";

let icon;
switch (process.platform) {
  case "win32":
    icon = "assets/icon_256";
    break;
  case "darwin":
    icon = ["assets/icon.icns", "assets/icon.icon"];
    break;
  default:
    icon = undefined;
    break;
}

const config: ForgeConfig = {
  packagerConfig: {
    icon,
    asar: {
      unpack: "**/*.{so*,dylib,dll}",
    },

    beforeCopy: [deployDependencies],
    afterCopy: [restoreDependencies, copyBuiltinPlugins],
    afterExtract: [pruneLocales, extractLicenses, replaceIcuData],

    // In offline environments (e.g. flatpak sandbox), SHASUMS256.txt cannot be
    // downloaded from GitHub. The electron zip is already verified by sha256 in
    // generated-node-sources.json, so it's safe to skip checksum verification.
    ...(process.env.ELECTRON_OFFLINE_BUILD ? { download: { unsafelyDisableChecksums: true } } : {}),

    // Override Vite Plugin's preferences, and with our preferences.
    ignore: (file: string) => {
      if (!file) return false;

      return (
        file.startsWith("/node_modules/.") ||
        file.startsWith("/node_modules/electron/") ||
        file.startsWith("/node_modules/electron-nightly/") ||
        file.startsWith("/node_modules/@napi-rs/") ||
        (!file.startsWith("/package.json") &&
          !file.startsWith("/.vite") &&
          !file.startsWith("/node_modules"))
      );
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: metadata.squirrel.name,
      title: metadata.squirrel.title,
      description: metadata.summary,
      authors: pkg.author?.name ?? "",
      setupIcon: metadata.squirrel.setupIcon,
    }),
    new MakerZIP({}, ["darwin"]),
    new MakerFlatpak({
      id: metadata.appId,
      runtimeVersion: metadata.flatpak.runtimeVersion,
      baseVersion: metadata.flatpak.baseVersion,
      finishArgs: metadata.flatpak.finishArgs,
    }),
    new MakerDeb(),
    new MakerRpm(),
    new MakerAppImage({ icon: metadata.icons }),
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
          entry: "src/windows/color-picker.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
        {
          entry: "src/windows/plugin-manager.ts",
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
        {
          entry: "src/worklets/audio-effect.ts",
          config: "vite.worklets.config.ts",
          target: "preload",
        },
        {
          entry: "src/worklets/av3a-player.ts",
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
