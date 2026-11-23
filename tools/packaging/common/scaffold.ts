import { basename, dirname, extname, join } from "node:path";
import { cp, mkdir } from "node:fs/promises";

import { toMerged } from "es-toolkit";

import { type Icons, writeIcons } from "./icons.ts";
import { createSymlink } from "./util.ts";

export interface ScaffoldOptions {
  id: string;
  appName?: string;
  /** Name of the executable in `app` folder */
  executable: string;
  /** Input files, if omitted, the corresponding items won't be written. */
  input?: {
    app?: string;
    icons?: Icons;
    desktop?: string;
  };
  /** Paths relative to `root` */
  paths?: {
    app?: string;
    icons?: {
      appName: string;
      path: string;
    };
    desktop?: string;
    symlink?: string | true;
  };
}

export async function writeScaffold(root: string, options: ScaffoldOptions) {
  const appName =
    options.appName ??
    (options.input?.desktop
      ? basename(options.input.desktop, extname(options.input.desktop))
      : undefined);
  if (!appName) throw new Error("Cannot infer app name.");

  // Merge the caller's path overrides over the computed defaults. `toMerged`
  // skips `undefined` source values, so omitting `paths` (or any key in it)
  // leaves the corresponding defaults intact. `symlink: true` is a sentinel
  // for the default executable location.
  const paths = toMerged(
    {
      app: `/usr/lib/${options.id}/`,
      icons:
        options.input?.icons && options.input?.desktop
          ? {
              appName: basename(options.input.desktop, extname(options.input.desktop)),
              path: "/usr/share/icons/hicolor/",
            }
          : undefined,
      desktop: options.input?.desktop ? `/usr/share/applications/${appName}.desktop` : undefined,
    },
    {
      ...options.paths,
      symlink: options.paths?.symlink === true ? `/usr/bin/${options.id}` : options.paths?.symlink,
    }
  );

  // 1. App directory
  if (options.input?.app && paths.app) {
    await cp(options.input.app, join(root, paths.app), { recursive: true });
  }

  // 2. Icons
  if (options.input?.icons && paths.icons) {
    await writeIcons(join(root, paths.icons.path), paths.icons.appName, options.input.icons);
  }

  // 3. Desktop file
  if (options.input?.desktop && paths.desktop) {
    const dest = join(root, paths.desktop);
    await mkdir(dirname(dest), { recursive: true });
    await cp(options.input.desktop, dest);
  }

  // 4. Binary symlink
  if (paths.symlink) {
    if (!options.executable) throw new Error("Cannot create symlink: `executable` is required.");
    await createSymlink(join(root, paths.app ?? "", options.executable), join(root, paths.symlink));
  }
}
