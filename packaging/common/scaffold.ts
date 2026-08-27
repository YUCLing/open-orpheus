import { basename, dirname, extname, join } from "node:path";
import { cp, mkdir } from "node:fs/promises";

import _ from "lodash";

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

  // Normalize the `symlink: true` sentinel to its default path before merging,
  // otherwise `_.merge` would overwrite the computed default back to `true`.
  const effective: ScaffoldOptions = {
    ...options,
    paths: options.paths && {
      ...options.paths,
      symlink:
        options.paths.symlink === true
          ? `/usr/bin/${options.id}`
          : options.paths.symlink,
    },
  };

  const opts = _.merge(
    {
      paths: {
        app: `/usr/lib/${options.id}/`,
        icons:
          options.input?.icons && options.input?.desktop
            ? {
                appName: basename(
                  options.input.desktop,
                  extname(options.input.desktop)
                ),
                path: "/usr/share/icons/hicolor/",
              }
            : undefined,
        desktop: options.input?.desktop
          ? `/usr/share/applications/${appName}.desktop`
          : undefined,
      },
    },
    effective
  ) as ScaffoldOptions;

  // `paths` is always present after the merge (we seeded it), and the
  // `symlink` sentinel was normalized to a real path, so narrow the type.
  const paths = opts.paths as {
    app?: string;
    icons?: { appName: string; path: string };
    desktop?: string;
    symlink?: string;
  };

  // 1. App directory
  if (opts.input?.app && paths.app) {
    await cp(opts.input.app, join(root, paths.app), { recursive: true });
  }

  // 2. Icons
  if (opts.input?.icons && paths.icons) {
    await writeIcons(
      join(root, paths.icons.path),
      paths.icons.appName,
      opts.input.icons
    );
  }

  // 3. Desktop file
  if (opts.input?.desktop && paths.desktop) {
    const dest = join(root, paths.desktop);
    await mkdir(dirname(dest), { recursive: true });
    await cp(opts.input.desktop, dest);
  }

  // 4. Binary symlink
  if (paths.symlink) {
    if (!opts.executable)
      throw new Error("Cannot create symlink: `executable` is required.");
    await createSymlink(
      join(root, paths.app ?? "", opts.executable),
      join(root, paths.symlink)
    );
  }
}
