import type { Icons } from "./common/icons.ts";

/**
 * Build controls for the custom Debian (.deb) maker (`build-plugins/MakerDeb.ts`),
 * which delegates to the shared prebuilt builder.
 *
 * Package metadata (name, section, maintainer, homepage, description) is not
 * configurable here: the builder resolves it from `package.json` and the shared
 * `packaging/resources/metadata.ts`.
 */
export interface MakerDebOptions {
  /** Skip the build-dependency check (safe: prebuilt mode compiles nothing). Defaults to true. */
  nodeps?: boolean;
  /** Empty the maker's output directory (`out/make/deb/<arch>`) before building. Defaults to true. */
  clean?: boolean;
}

/**
 * Build controls for the custom RPM maker (`build-plugins/MakerRpm.ts`), which
 * delegates to the shared prebuilt builder.
 *
 * Package metadata (name, summary, license, homepage) is not configurable here:
 * the builder resolves it from `package.json` and the shared
 * `packaging/resources/metadata.ts`.
 */
export interface MakerRpmOptions {
  /** Skip the build-dependency check (safe: prebuilt mode compiles nothing). Defaults to true. */
  nodeps?: boolean;
  /** Empty the maker's output directory (`out/make/rpm/<arch>`) before building. Defaults to true. */
  clean?: boolean;
}

/**
 * Configuration for the custom Flatpak maker
 * (`build-plugins/MakerFlatpak.ts`), which reuses the packaged Electron app through
 * a prebuilt-aware Flathub builder manifest and bundles it into a `.flatpak`.
 */
export interface MakerFlatpakOptions {
  /** Flatpak app ID (reverse-DNS, e.g. `io.github.yucling.open-orpheus`). Required: without it the manifest has no `app-id`. */
  id: string;
  /** Executable/app name (e.g. `open-orpheus`). Defaults to package.json `name`. */
  name?: string;
  /** Empty the maker's output directory (`out/make/flatpak/<arch>`) before building. Defaults to true. */
  clean?: boolean;
  /** Path (relative to the project) to the AppStream metainfo. Defaults to `packaging/flatpak/metainfo.xml`. */
  metainfo?: string;
  /** Runtime version (e.g. `26.08`). Defaults to `"26.08"`. */
  runtimeVersion?: string;
  /** Base-app version (e.g. `26.08`). Defaults to `"26.08"`. */
  baseVersion?: string;
  /** Extra `--finish-args`. */
  finishArgs?: string[];
  /** Extra manifest modules appended before the app module. */
  modules?: unknown[];
}

/**
 * Configuration for the custom AppImage maker (`plugins/MakerAppImage.ts`),
 * which assembles an AppDir from the already-packaged Electron app, squashes it
 * with the system `mksquashfs` and prepends the AppImage type-2 runtime.
 */
export interface MakerAppImageOptions {
  /** Executable/app name (e.g. `open-orpheus`): the AppDir layout (`usr/lib/<name>`), the icon basename and the desktop entry's `Exec`/`Icon`. Defaults to package.json `name`. */
  name?: string;
  /** Empty the maker's output directory (`out/make/AppImage/<arch>`) before building. Defaults to true. */
  clean?: boolean;
  /**
   * Icons installed into the AppDir as a `size -> source icon` map, e.g.
   * `{ "512x512": "assets/icon_512.png", scalable: "assets/icon.svg" }` (in
   * `forge.config.ts` this is `metadata.icons`). Paths are resolved against the
   * project root. Required, and must not be empty: the largest icon also
   * becomes the AppImage's `.DirIcon`.
   */
  icon: Icons;
  /** Path (relative to the project root) of a prebuilt `.desktop` file. Defaults to the shared desktop template. */
  desktopFile?: string;
  /** SquashFS compressor. Defaults to the `mksquashfs` default (usually `gzip`). */
  compressor?: "xz" | "gzip" | "lz4" | "lzo" | "zstd" | "lzma";
  /**
   * The AppImage type-2 runtime to prepend: either a local file path or an
   * `http(s)` URL. Defaults to `$APPIMAGE_RUNTIME`, then to the official
   * `type2-runtime` release matching the target architecture. Remote runtimes
   * are cached in `out/.cache/appimage/`.
   */
  runtime?: string;
  /** Expected SHA-256 of the runtime (hex, optionally prefixed with `sha256:`). */
  runtimeChecksum?: string;
}
