// Generates the install scaffolding (desktop file, icons, symlink) into a
// target directory. All options come from the command line (no
// packaging/options.ts); every control falls back to the RPM/Debian /usr
// defaults, so only the values that differ need to be passed:
//   node scripts/build-scaffold.ts <out-dir> [--name <name>] [--desktop-name <name>]
//       [--icon-app-name <name>] [--app-path <path>] [--icons-path <path>]
//       [--desktop-path <path>] [--symlink-path <path>] [--with-zypak-wrapper]
import { dirname, join, resolve } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { createDesktopFile } from "../packaging/common/desktop.ts";
import { writeScaffold } from "../packaging/common/scaffold.ts";

const projectRoot = resolve(import.meta.dirname, "..");

const argv = process.argv.slice(2);

const outDir = resolve(argv[0] ?? ".");
await mkdir(outDir, { recursive: true });

const flagValue = (flag: string) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};
const requireFlag = (flag: string): string => {
  const value = flagValue(flag);
  if (!value) throw new Error(`Missing required flag: ${flag} <value>`);
  return value;
};
const name = requireFlag("--name");

// Precise, overridable layout controls. Defaults reproduce the RPM/Debian /usr
// layout; the Flatpak caller overrides the app-ID naming and /app paths.
const desktopName = flagValue("--desktop-name") ?? name;
// Icon basename AND the desktop `Icon=` value — Flathub's `gui-app-without-icon`
// / `desktop-app-id` lint wants the app ID here, not the executable name.
const iconAppName = flagValue("--icon-app-name") ?? name;
const appPath = flagValue("--app-path") ?? `/usr/lib/${name}/`;
const iconsPath = flagValue("--icons-path") ?? "/usr/share/icons/hicolor/";
const desktopDir = flagValue("--desktop-path") ?? "/usr/share/applications";
const symlinkPath = flagValue("--symlink-path") ?? `/usr/bin/${name}`;
// Generate the zypak electron-wrapper shim (next to the symlink) and point the
// desktop Exec at it — the Flatpak manifest `command` matches.
const withZypakWrapper = argv.includes("--with-zypak-wrapper");

const desktopExecutable = withZypakWrapper ? "electron-wrapper" : name;

// Generate the desktop file first; writeScaffold copies it into the layout.
// It is written to a temp dir so it never lands at the top of `outDir` — for
// Flatpak, `outDir` = /app is the whole export and a stray top-level .desktop
// trips flatpak-builder-lint ("Wrong desktop file placement").
const desktopFilename = `${desktopName}.desktop`;
const desktopTmp = await mkdtemp(join(tmpdir(), "scaffold-"));
const desktopFile = join(desktopTmp, desktopFilename);
await createDesktopFile(desktopFile, {
  executable: desktopExecutable,
  icon: iconAppName,
});

await writeScaffold(outDir, {
  id: name,
  appName: name,
  executable: name,
  input: {
    icons: {
      "256x256": resolve(projectRoot, "assets/icon_256.png"),
      "512x512": resolve(projectRoot, "assets/icon_512.png"),
      scalable: resolve(projectRoot, "assets/icon.svg"),
    },
    desktop: desktopFile,
  },
  paths: {
    app: appPath,
    icons: { appName: iconAppName, path: iconsPath },
    desktop: join(desktopDir, desktopFilename),
    symlink: symlinkPath,
  },
});
// The intermediate desktop was consumed by writeScaffold.
await rm(desktopTmp, { recursive: true, force: true });

if (withZypakWrapper) {
  // The app runs inside the sandbox via zypak, so generate the electron-wrapper
  // shim that the desktop Exec and the manifest command point at. It lives in
  // the same directory as the /bin symlink. Use join(), not resolve(): the
  // absolute dirname(/bin) must stay under outDir (/app), not reset to /bin.
  const wrapperPath = join(outDir, dirname(symlinkPath), "electron-wrapper");
  await mkdir(dirname(wrapperPath), { recursive: true });
  await writeFile(wrapperPath, `#!/bin/sh\n\nzypak-wrapper "${name}" "$@"\n`, {
    mode: 0o755,
  });
}

console.log(`Install scaffolding written to ${outDir}`);
