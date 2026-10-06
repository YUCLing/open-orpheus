import { dirname, extname, resolve } from "node:path";
import { copyFile, mkdir } from "node:fs/promises";

export type Icons = Partial<Record<`${string}x${string}` | "scalable", string>>;

/**
 * Resolve every icon source in `icons` against `root`. Metadata stores icon
 * paths project-relative, while `writeIcons` copies them from the filesystem.
 */
export function resolveIcons(root: string, icons: Icons | undefined): Icons {
  const resolved = { ...icons };
  const bySize = resolved as Record<string, string | undefined>;
  for (const [size, source] of Object.entries(resolved)) {
    if (source) bySize[size] = resolve(root, source);
  }
  return resolved;
}

/**
 * Write icons using file structure: `/$size/apps/$appName.$ext`
 *
 * Each key of `icons` is a size (e.g. `256x256`) or `scalable`; the value is
 * the path to the source icon. The destination extension is taken from the
 * source file.
 *
 * @param path base directory to write the icons into, e.g. `/usr/share/icons/hicolor/`
 * @param appName base name of the icon files
 * @param icons mapping of size -> source icon path
 */
export async function writeIcons(path: string, appName: string, icons: Icons) {
  await Promise.all(
    Object.entries(icons).map(async ([size, source]) => {
      if (!source) return;
      const dest = resolve(path, size, "apps", `${appName}${extname(source)}`);
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(source, dest);
    })
  );
}
