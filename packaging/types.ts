/**
 * Configuration for the custom Debian (.deb) maker
 * (`plugins/MakerDeb.ts`), which delegates to the shared prebuilt builder.
 */
export interface MakerDebOptions {
  /** Skip the build-dependency check (safe: prebuilt mode compiles nothing). Defaults to true. */
  nodeps?: boolean;
  /** Package name (e.g. `open-orpheus`). Defaults to package.json `name`. */
  name?: string;
  /** Debian section (e.g. `sound`). Defaults to `"sound"`. */
  section?: string;
  /** Maintainer in `Name <email>` form. Defaults to package.json `author`. */
  maintainer?: string;
  /** Homepage URL. Defaults to package.json `homepage`. */
  homepage?: string;
  /** Short description (continuation lines are indented automatically). Defaults to package.json `description`. */
  description?: string;
}

/**
 * Configuration for the custom RPM maker
 * (`plugins/MakerRpm.ts`), which delegates to the shared prebuilt builder.
 */
export interface MakerRpmOptions {
  /** Skip the build-dependency check (safe: prebuilt mode compiles nothing). Defaults to true. */
  nodeps?: boolean;
  /** Package name (e.g. `open-orpheus`). Defaults to package.json `name`. */
  name?: string;
  /** Short description, used in the spec `Summary` field. */
  description?: string;
  /** License identifier, used in the spec `License` field. */
  license?: string;
  /** Homepage URL, used in the spec `URL` field. */
  homepage?: string;
}

/**
 * Configuration for the custom Flatpak maker
 * (`plugins/MakerFlatpak.ts`), which reuses the packaged Electron app through
 * a prebuilt-aware Flathub builder manifest and bundles it into a `.flatpak`.
 */
export interface MakerFlatpakOptions {
  /** Flatpak app ID (reverse-DNS, e.g. `io.github.yucling.open-orpheus`). */
  id?: string;
  /** Executable/app name (e.g. `open-orpheus`). Defaults to package.json `name`. */
  name?: string;
  /** Path (relative to the project) to the AppStream metainfo. Defaults to `packaging/flatpak/metainfo.xml`. */
  metainfo?: string;
  /** Runtime version (e.g. `25.08`). Defaults to `"25.08"`. */
  runtimeVersion?: string;
  /** Base-app version (e.g. `25.08`). Defaults to `"25.08"`. */
  baseVersion?: string;
  /** Extra `--finish-args`. */
  finishArgs?: string[];
  /** Extra manifest modules appended before the app module. */
  modules?: unknown[];
}
