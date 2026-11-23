import { existsSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";

import { PROJECT_ROOT } from "../../shared/paths.ts";

/** Replace Electron's `icudtl.dat` with the smaller, filtered build. */
export async function replaceIcuData({
  buildPath,
  platform,
}: {
  buildPath: string;
  platform: string;
}): Promise<void> {
  const source = resolve(PROJECT_ROOT, "tools/packaging/resources/icudtl.dat");
  if (!existsSync(source)) return;

  const target =
    platform === "mas" || platform === "darwin"
      ? resolve(
          buildPath,
          "Electron.app/Contents/Frameworks/Electron Framework.framework/Resources/icudtl.dat"
        )
      : resolve(buildPath, "icudtl.dat");

  await copyFile(source, target);
}
