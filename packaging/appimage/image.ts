import { createReadStream, createWriteStream } from "node:fs";
import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import { generateDesktop } from "../common/desktop.ts";
import { resolveIcons } from "../common/icons.ts";
import { writeScaffold } from "../common/scaffold.ts";
import { createSymlink } from "../common/util.ts";
import { resolveRuntime } from "./runtime.ts";
import { createSquashFs, type SquashFsCompressor } from "./squashfs.ts";
import type { Icons } from "../common/icons.ts";

/**
 * AppImage image assembly.
 *
 * The AppImage file format is a type-2 runtime with a SquashFS image appended
 * to it, so building one is three steps: assemble the AppDir (the `/usr`
 * tree plus `AppRun` and the root desktop entry), squash it, then prepend the
 * runtime. This mirrors what `appimagetool` does, using the system
 * `mksquashfs` instead of shipping one.
 */

export interface BuildAppImageOptions {
  /** Project root: relative paths (icons, desktop file) and the runtime cache live here. */
  projectRoot: string;
  /** The packaged Electron app (Forge's `dir`). */
  appDir: string;
  /** Directory that receives the `.AppImage` and the intermediate AppDir. */
  outDir: string;
  /** Executable/app name: the AppDir layout (`usr/lib/<name>`), icon basename and `Exec`/`Icon`. */
  name: string;
  /** Application version, embedded in the desktop entry and the artifact name. */
  version: string;
  /** AppImage arch name (e.g. `x86_64`). */
  arch: string;
  /** Icons installed into the AppDir, as a `size -> source` map. At least one is required. */
  icon?: Icons;
  /** Prebuilt `.desktop` file to use instead of the shared template. */
  desktopFile?: string | undefined;
  /** SquashFS compressor. Defaults to the `mksquashfs` default. */
  compressor?: SquashFsCompressor | undefined;
  /** Runtime file path or URL. Defaults to the official release for `arch`. */
  runtime?: string | undefined;
  /** Expected SHA-256 of the runtime. */
  runtimeChecksum?: string | undefined;
}

const FIXED_SIZE = /^(\d+)x(\d+)$/;

/**
 * The largest explicitly sized icon, falling back to the `scalable` one. It
 * becomes the AppImage's `.DirIcon` (the thumbnail file managers show).
 */
function pickDefaultIcon(icons: Icons): { size: string; source: string } | undefined {
  let largest: { size: string; source: string; area: number } | undefined;
  for (const [size, source] of Object.entries(icons)) {
    const dimensions = FIXED_SIZE.exec(size);
    if (!source || !dimensions) continue;
    const area = Number(dimensions[1]) * Number(dimensions[2]);
    if (!largest || area > largest.area) largest = { size, source, area };
  }
  if (largest) return largest;
  return icons.scalable ? { size: "scalable", source: icons.scalable } : undefined;
}

/**
 * Render the desktop entry: the shared template plus the AppImage metadata
 * keys the runtime and integration tools read back from the AppDir root.
 */
async function renderDesktop(options: {
  name: string;
  version: string;
  arch: string;
}): Promise<string> {
  const desktop = await generateDesktop({ executable: options.name, icon: options.name });
  const extras = [
    "Version=1.5",
    `X-AppImage-Name=${options.name}`,
    `X-AppImage-Version=${options.version}`,
    `X-AppImage-Arch=${options.arch}`,
  ];
  const header = "[Desktop Entry]";
  const at = desktop.indexOf(header);
  if (at === -1) return `${header}\n${extras.join("\n")}\n${desktop}`;
  const end = at + header.length;
  return `${desktop.slice(0, end)}\n${extras.join("\n")}${desktop.slice(end)}`;
}

/**
 * Assemble the AppDir at `appTree`: the `/usr` tree (app, icons, desktop entry,
 * `usr/bin/<name>`), the `AppRun` the runtime executes, and the root desktop
 * entry and `.DirIcon` that integration tooling reads.
 */
async function createAppDir(options: {
  projectRoot: string;
  appDir: string;
  outDir: string;
  appTree: string;
  name: string;
  version: string;
  arch: string;
  icons: Icons;
  desktopFile?: string | undefined;
}): Promise<void> {
  const { projectRoot, appDir, outDir, appTree, name, version, arch, icons } = options;

  const desktopName = `${name}.desktop`;
  const desktopSource = options.desktopFile
    ? resolve(projectRoot, options.desktopFile)
    : join(outDir, desktopName);
  if (!options.desktopFile) {
    await writeFile(desktopSource, await renderDesktop({ name, version, arch }));
  }

  await writeScaffold(appTree, {
    id: name,
    appName: name,
    executable: name,
    input: { app: appDir, icons, desktop: desktopSource },
    paths: {
      app: `/usr/lib/${name}/`,
      icons: { appName: name, path: "/usr/share/icons/hicolor/" },
      desktop: `/usr/share/applications/${desktopName}`,
      symlink: `/usr/bin/${name}`,
    },
  });

  await createSymlink(join(appTree, "usr/bin", name), join(appTree, "AppRun"));
  await createSymlink(
    join(appTree, "usr/share/applications", desktopName),
    join(appTree, desktopName)
  );
  const defaultIcon = pickDefaultIcon(icons);
  if (defaultIcon) {
    const iconName = `${name}${extname(defaultIcon.source)}`;
    const iconPath = join(appTree, "usr/share/icons/hicolor", defaultIcon.size, "apps", iconName);
    await createSymlink(iconPath, join(appTree, ".DirIcon"));
    await createSymlink(iconPath, join(appTree, iconName));
  }
  await chmod(appTree, 0o755);
}

/**
 * Build the `.AppImage` for the packaged app at `options.appDir` and return its
 * path. The intermediate AppDir, desktop entry and SquashFS image stay in
 * `outDir` — the caller's staging directory takes care of cleaning them up.
 */
export async function buildAppImage(options: BuildAppImageOptions): Promise<string> {
  const { projectRoot, appDir, outDir, name, version, arch } = options;

  // The desktop entry and AppRun both exec this file, so a mismatch here would
  // only surface as a broken image at runtime.
  const executable = join(appDir, name);
  try {
    await access(executable);
  } catch {
    throw new Error(
      `Could not find the executable '${name}' in the packaged application ('${appDir}'). ` +
        "Make sure `packagerConfig.executableName` (or this maker's `name` option) matches it."
    );
  }

  const icons = resolveIcons(projectRoot, options.icon);
  if (Object.keys(icons).length === 0) {
    throw new Error("MakerAppImage requires at least one icon: set the maker's `icon` option.");
  }

  await mkdir(outDir, { recursive: true });
  const appTree = join(outDir, "AppDir");

  // Download the runtime while the AppDir is assembled, and settle both before
  // squashing — no point squashing on failure. `allSettled` also keeps the
  // download's rejection handled from the moment it happens (an un-awaited
  // rejection would crash the process before the caller can report it) and
  // guarantees no filesystem work outlives this call, so a caller cleaning up
  // its staging directory cannot race an assembly still writing into it.
  const [runtime, assembled] = await Promise.allSettled([
    resolveRuntime({
      projectRoot,
      arch,
      runtime: options.runtime,
      checksum: options.runtimeChecksum,
    }),
    createAppDir({
      projectRoot,
      appDir,
      outDir,
      appTree,
      name,
      version,
      arch,
      icons,
      desktopFile: options.desktopFile,
    }),
  ]);
  if (runtime.status === "rejected") throw runtime.reason;
  if (assembled.status === "rejected") throw assembled.reason;
  const runtimeData = runtime.value;

  // Squash the AppDir, then prepend the runtime: runtime bytes first, the image
  // appended (streamed, so a ~300 MB image is never held in memory).
  const artifactName = `${name}-${version}-${arch}.AppImage`;
  const imagePath = join(outDir, `${artifactName}.squashfs`);
  await createSquashFs(appTree, imagePath, { compressor: options.compressor });

  const artifact = join(outDir, artifactName);
  await writeFile(artifact, runtimeData);
  await pipeline(createReadStream(imagePath), createWriteStream(artifact, { flags: "a" }));
  await chmod(artifact, 0o755);
  await rm(imagePath, { force: true });

  return artifact;
}
