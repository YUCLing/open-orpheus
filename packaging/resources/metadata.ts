import type { Icons } from "../common/icons.ts";

/**
 * Shared packaging metadata: the single source of truth for the values the
 * makers and builders need that `package.json` does not already provide.
 *
 * npm identity — `name`, `version`, `description`, `license`, `author` — stays
 * in `package.json`, which every builder already receives and falls back to.
 * Only overrides and gaps live here, so no format restates another's value.
 *
 * The desktop entry is deliberately *not* covered: its text is written as-is by
 * `packaging/resources/open-orpheus.desktop.ejs`.
 */

/** Flatpak build controls (the maker's config and the Flathub manifest). */
export interface FlatpakMetadata {
  /** Freedesktop runtime version (e.g. `26.08`). */
  runtimeVersion: string;
  /** Electron base-app version (e.g. `26.08`). */
  baseVersion: string;
  /** Permissions granted to the sandbox. */
  finishArgs: string[];
  /** Extra manifest modules appended before the app module (currently none). */
  modules?: unknown[];
}

/** Windows installer naming: `package.json`'s `name` is not a shortcut name. */
export interface SquirrelMetadata {
  /** Shortcut/executable name (no dashes). */
  name: string;
  /** Displayed title. */
  title: string;
  /** Installer icon. */
  setupIcon: string;
}

export interface Metadata {
  /** Reverse-DNS application ID: the Flatpak ID, the AppStream `<id>` and the installed desktop ID. */
  appId: string;
  /** Project homepage: the Debian `Homepage:` field and the RPM `URL:` field. */
  homepage: string;
  /** One-line summary: the RPM `Summary:` field and the Windows installer description. */
  summary: string;
  /** Multi-line description for the Debian control `Description:` field. */
  description: string;
  /** Icons installed by every format, as a `size -> path relative to the project root` map. */
  icons: Icons;
  squirrel: SquirrelMetadata;
  flatpak: FlatpakMetadata;
}

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
    ],
  },
};
