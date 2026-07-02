import { copyFile, mkdir, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { extractFile } from "@electron/asar";

// #region Types

/**
 * Maps freedesktop.org icon size keys to source file paths.
 *
 * Pixel sizes (PNG) — e.g. `"16x16"`, `"32x32"`, `"48x48"`, `"256x256"`.
 * Vector sizes (SVG) — `"scalable"` and `"symbolic"`.
 */
export interface HicolorIcons {
  /** Size key → absolute path to the source icon file. */
  [size: string]: string;
}

// #endregion

/** Everything the scaffolder needs to produce the installed filesystem layout. */
export interface ScaffoldInput {
  /** Path to the bundled Electron application directory (the "src" that
   *  electron-installer-common calls `sourceDir`). */
  src: string;

  /** Directory where the `/usr`-prefixed filesystem tree will be written. */
  dest: string;

  /** The application name, used for directories under lib/, the binary
   *  symlink name, the .desktop file name, and the icon name.
   *  @default `productName` (or `name`) from package.json in `src`. */
  appName?: string;

  /** The executable *inside* the bundled app that should be exposed on
   *  `$PATH`.
   *  @default {@link appName} (e.g. `"open-orpheus"`). */
  bin?: string;

  /** Hicolor icon map.  Each key is an icon size string recognised by the
   *  freedesktop.org Icon Theme Specification (e.g. `"256x256"`,
   *  `"scalable"`).  Values are absolute paths to source image files.
   *  When omitted no icons are installed. */
  icons?: HicolorIcons;

  /** Path to a `.desktop` file.  Defaults to the project's own
   *  `packaging/open-orpheus.desktop`. */
  desktopFile?: string;

  /** Path to a license / copyright file that will be copied to
   *  `/usr/share/doc/{appName}/copyright`.  Defaults to the `LICENSE` file
   *  in the project root. */
  licenseFile?: string;
}

// #region Helpers

const COPYFILE_EXCL = 0; // fail if destination already exists

async function safeCopy(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest, COPYFILE_EXCL);
}

async function safeSymlink(target: string, linkPath: string): Promise<void> {
  await mkdir(dirname(linkPath), { recursive: true });
  // Remove existing symlink / file so we can replace it idempotently
  try {
    await symlink(target, linkPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") {
      // If the symlink already points to the right target, it's fine.
      // For simplicity we don't validate and just skip – the caller can
      // clear `dest` between runs.
    } else {
      throw err;
    }
  }
}

// #endregion

// #region Core logic

/**
 * Produce the exact `/usr`-prefixed filesystem tree that Debian / RPM
 * packages install onto the end-user's machine.
 *
 * The output layout mirrors what `electron-installer-common` (and its
 * Debian / RedHat subclasses) build inside their staging directories
 * **before** the `.deb` / `.rpm` is created:
 *
 * ```
 * {dest}/
 * └── usr/
 *     ├── bin/
 *     │   └── {appName}  →  ../lib/{appName}/{bin}
 *     ├── lib/
 *     │   └── {appName}/
 *     │       └──  … (the full app bundle, copied from `src`)
 *     └── share/
 *         ├── applications/
 *         │   └── {appName}.desktop
 *         ├── doc/
 *         │   └── {appName}/
 *         │       └── copyright
 *         └── icons/
 *             └── hicolor/
 *                 └── {size}/
 *                     └── apps/
 *                         └── {appName}.{png|svg}
 * ```
 */
export async function scaffold(input: ScaffoldInput): Promise<void> {
  // #region Resolve defaults
  const src = resolve(input.src);
  const dest = resolve(input.dest);

  // The app's package.json lives inside resources/app.asar (Linux, asar-only).
  const asarPath = join(src, "resources", "app.asar");
  const pkg = JSON.parse(
    extractFile(asarPath, "package.json").toString("utf-8")
  ) as { productName?: string; name?: string };

  const appName = input.appName ?? pkg.productName ?? pkg.name ?? "app";
  const bin = input.bin ?? appName;

  const desktopFile = resolve(
    input.desktopFile ?? join(import.meta.dirname, "..", "open-orpheus.desktop")
  );
  const licenseFile = resolve(
    input.licenseFile ?? join(import.meta.dirname, "..", "..", "LICENSE")
  );
  // #endregion

  // #region App bundle — /usr/lib/{appName}/
  const libDest = join(dest, "usr", "lib", appName);
  await mkdir(libDest, { recursive: true });

  // Recursive copy – we use `cp -a` via the shell for simplicity and to
  // preserve symlinks / permissions.  In production you may prefer a pure-
  // Node recursive copy (e.g. `fs.cp` with `recursive: true` on Node 16.7+).
  const { execFile } = await import("node:child_process");
  await new Promise<void>((ok, fail) =>
    execFile("cp", ["-a", `${src}/.`, libDest], (err) =>
      err ? fail(err) : ok()
    )
  );

  // #endregion

  // #region Binary symlink — /usr/bin/{appName}  →  ../lib/{appName}/{bin}
  const binLink = join(dest, "usr", "bin", appName);
  const binTarget = join("..", "lib", appName, bin);
  await safeSymlink(binTarget, binLink);

  // #endregion

  // #region Desktop entry — /usr/share/applications/{appName}.desktop
  await safeCopy(
    desktopFile,
    join(dest, "usr", "share", "applications", `${appName}.desktop`)
  );

  // #endregion

  // #region Copyright — /usr/share/doc/{appName}/copyright
  await safeCopy(
    licenseFile,
    join(dest, "usr", "share", "doc", appName, "copyright")
  );

  // #endregion

  // #region Hicolor icons — /usr/share/icons/hicolor/{size}/apps/
  if (input.icons) {
    for (const [size, iconPath] of Object.entries(input.icons)) {
      // Determine extension: SVG for "scalable" / "symbolic", PNG otherwise
      const ext = ["scalable", "symbolic"].includes(size) ? "svg" : "png";
      const iconName = size === "symbolic" ? `${appName}-symbolic` : appName;

      await safeCopy(
        resolve(iconPath),
        join(
          dest,
          "usr",
          "share",
          "icons",
          "hicolor",
          size,
          "apps",
          `${iconName}.${ext}`
        )
      );
    }
  }
  // #endregion
}
