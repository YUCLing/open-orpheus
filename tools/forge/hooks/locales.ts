import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const LOCALES = ["en", "en-US", "zh-CN"];

/** Remove Electron locale packs the app does not ship. */
export async function pruneLocales({
  buildPath,
  platform,
}: {
  buildPath: string;
  platform: string;
}): Promise<void> {
  if (platform === "mas" || platform === "darwin") {
    const resourcesPath = resolve(buildPath, "Electron.app/Contents/Resources");
    const frameworkResourcesPath = resolve(
      buildPath,
      "Electron.app/Contents/Frameworks/Electron Framework.framework/Resources"
    );

    const resources = await readdir(resourcesPath, {
      withFileTypes: true,
    });
    const frameworkResources = await readdir(frameworkResourcesPath, {
      withFileTypes: true,
    });
    await Promise.all(
      [...resources, ...frameworkResources].map(async (locale) => {
        if (!locale.isDirectory() || !locale.name.endsWith(".lproj")) return;
        if (LOCALES.some((v) => locale.name.replace("_", "-").startsWith(v))) return;
        await rm(resolve(locale.parentPath, locale.name), {
          recursive: true,
        });
      })
    );

    return;
  }

  const localesPath = resolve(buildPath, "locales");

  const locales = await readdir(localesPath, { withFileTypes: true });
  await Promise.all(
    locales.map(async (locale) => {
      if (!locale.isFile()) return;
      if (LOCALES.includes(locale.name.substring(0, locale.name.length - 4).replace("_", "-")))
        return;
      await rm(resolve(locale.parentPath, locale.name));
    })
  );
}
