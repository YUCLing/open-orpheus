// Generates the install scaffolding (desktop file, icons, symlink) into a
// target directory. All layout options come from the command line; the icons
// come from the shared `tools/config/packaging.ts`, and every control falls
// back to the RPM/Debian /usr defaults, so only the values that differ need to
// be passed:
//   node tools/scripts/build-scaffold.ts <out-dir> [--name <name>] [--desktop-name <name>]
//       [--icon-app-name <name>] [--app-path <path>] [--icons-path <path>]
//       [--desktop-path <path>] [--symlink-path <path>] [--with-zypak-wrapper]
import { resolve } from "node:path";

import { createInstallScaffold } from "../packaging/install-scaffold.ts";
import { flagValue, hasFlag, requireFlag } from "../shared/cli.ts";

const argv = process.argv.slice(2);
const outDir = resolve(argv[0] ?? ".");
const name = requireFlag(argv, "--name");

await createInstallScaffold({
  outDir,
  name,
  desktopName: flagValue(argv, "--desktop-name"),
  iconAppName: flagValue(argv, "--icon-app-name"),
  appPath: flagValue(argv, "--app-path"),
  iconsPath: flagValue(argv, "--icons-path"),
  desktopPath: flagValue(argv, "--desktop-path"),
  symlinkPath: flagValue(argv, "--symlink-path"),
  withZypakWrapper: hasFlag(argv, "--with-zypak-wrapper"),
});

console.log(`Install scaffolding written to ${outDir}`);
