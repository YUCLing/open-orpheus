/** Interfaces for the shared packaging metadata in `packaging.ts`. */

import type { Icons } from "./common/icons.ts";

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
