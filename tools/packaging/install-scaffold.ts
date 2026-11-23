import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { PROJECT_ROOT } from "../shared/paths.ts";
import { createDesktopFile } from "./common/desktop.ts";
import { resolveIcons, type Icons } from "./common/icons.ts";
import { writeScaffold } from "./common/scaffold.ts";
import { metadata } from "../config/packaging.ts";

export interface InstallScaffoldOptions {
  /** Project root: icon paths from metadata are resolved against it. */
  projectRoot?: string;
  /** Directory that receives the `/usr` layout. */
  outDir: string;
  /** Executable / package name, e.g. `open-orpheus`. */
  name: string;
  /** Desktop file basename. Defaults to `name`. */
  desktopName?: string;
  /** Icon basename and desktop `Icon=` value. Defaults to `name`. */
  iconAppName?: string;
  /** Install path for the app directory. Defaults to `/usr/lib/<name>/`. */
  appPath?: string;
  /** Install path for the icon tree. Defaults to `/usr/share/icons/hicolor/`. */
  iconsPath?: string;
  /** Install directory for the desktop entry. Defaults to `/usr/share/applications`. */
  desktopPath?: string;
  /** Install path for the `/usr/bin` symlink. Defaults to `/usr/bin/<name>`. */
  symlinkPath?: string;
  /** Icons to install. Defaults to the shared packaging metadata icons. */
  icons?: Icons;
  /**
   * Generate the zypak `electron-wrapper` shim next to the symlink and point
   * the desktop `Exec` at it (used by the Flatpak builds).
   */
  withZypakWrapper?: boolean;
}

/**
 * Generate the install scaffolding (desktop entry, icons, app directory and
 * `/usr/bin` symlink) for a package layout.
 *
 * Every path is overridable so the same layout serves the Debian/RPM `/usr`
 * tree, the AppImage AppDir and the Flatpak `/app` export without three copies
 * of the assembly logic.
 */
export async function createInstallScaffold(options: InstallScaffoldOptions): Promise<void> {
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const outDir = resolve(options.outDir);
  const name = options.name;

  await mkdir(outDir, { recursive: true });

  // Precise, overridable layout controls. Defaults reproduce the RPM/Debian
  // /usr layout; Flatpak overrides the app-ID naming and /app paths.
  const desktopName = options.desktopName ?? name;
  // Icon basename AND the desktop `Icon=` value — Flathub's
  // `gui-app-without-icon` / `desktop-app-id` lint wants the app ID here, not
  // the executable name.
  const iconAppName = options.iconAppName ?? name;
  const appPath = options.appPath ?? `/usr/lib/${name}/`;
  const iconsPath = options.iconsPath ?? "/usr/share/icons/hicolor/";
  const desktopDir = options.desktopPath ?? "/usr/share/applications";
  const symlinkPath = options.symlinkPath ?? `/usr/bin/${name}`;

  // Generate the desktop file first; writeScaffold copies it into the layout.
  // It is written to a temp dir so it never lands at the top of `outDir` — for
  // Flatpak, `outDir` = /app is the whole export and a stray top-level
  // .desktop trips flatpak-builder-lint ("Wrong desktop file placement").
  const desktopExecutable = options.withZypakWrapper ? "electron-wrapper" : name;
  const desktopFilename = `${desktopName}.desktop`;
  const desktopTmp = await mkdtemp(join(tmpdir(), "scaffold-"));
  const desktopFile = join(desktopTmp, desktopFilename);
  await createDesktopFile(desktopFile, {
    executable: desktopExecutable,
    icon: iconAppName,
  });

  try {
    await writeScaffold(outDir, {
      id: name,
      appName: name,
      executable: name,
      input: {
        icons: resolveIcons(projectRoot, options.icons ?? metadata.icons),
        desktop: desktopFile,
      },
      paths: {
        app: appPath,
        icons: { appName: iconAppName, path: iconsPath },
        desktop: join(desktopDir, desktopFilename),
        symlink: symlinkPath,
      },
    });
  } finally {
    await rm(desktopTmp, { recursive: true, force: true });
  }

  if (options.withZypakWrapper) {
    // The app runs inside the sandbox via zypak, so generate the
    // electron-wrapper shim that the desktop Exec and the manifest command
    // point at. It lives in the same directory as the /bin symlink. Use
    // join(), not resolve(): the absolute dirname(/bin) must stay under
    // outDir (/app), not reset to /bin.
    const wrapperPath = join(outDir, dirname(symlinkPath), "electron-wrapper");
    await mkdir(dirname(wrapperPath), { recursive: true });
    await writeFile(wrapperPath, `#!/bin/sh\n\nzypak-wrapper "${name}" "$@"\n`, {
      mode: 0o755,
    });
  }
}
