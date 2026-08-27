// Generates the install scaffolding (desktop file, icons, /usr/bin symlink)
// into a target directory. Used by both the RPM and Debian builds after
// `pnpm install`, e.g.:
//   node scripts/build-scaffold.ts <out-dir>
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";

import { createDesktopFile } from "../packaging/common/desktop.ts";
import { writeScaffold } from "../packaging/common/scaffold.ts";

const projectRoot = resolve(import.meta.dirname, "..");

const outDir = resolve(process.argv[2] ?? ".");
await mkdir(outDir, { recursive: true });

const { rpm: rpmOptions } = await import(
  new URL("../packaging/options.ts", import.meta.url).href
);

const name = rpmOptions.name;

// Generate the desktop file first; writeScaffold copies it into the layout.
// It lives at the top of `outDir` (outside usr/), so it won't be installed.
const desktopPath = resolve(outDir, `${name}.desktop`);
await createDesktopFile(desktopPath, { executable: name });

await writeScaffold(outDir, {
  id: name,
  appName: name,
  executable: name,
  input: {
    icons: {
      "256x256": resolve(projectRoot, "assets/icon_256.png"),
      "512x512": resolve(projectRoot, "assets/icon_512.png"),
      "1024x1024": resolve(projectRoot, "assets/icon_1024.png"),
      scalable: resolve(projectRoot, "assets/icon.svg"),
    },
    desktop: desktopPath,
  },
  paths: { symlink: true },
});

console.log(`Install scaffolding written to ${outDir}`);
