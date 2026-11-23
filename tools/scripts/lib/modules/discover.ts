import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ModuleInfo } from "./types.ts";

/** Read `package.json` metadata for every module directory that has one. */
export async function readModuleInfos(
  modulesDir: string,
  moduleNames: string[]
): Promise<ModuleInfo[]> {
  return (
    await Promise.all(
      moduleNames.map(async (dirName) => {
        try {
          const modulePath = resolve(modulesDir, dirName);
          const pkg = JSON.parse(await readFile(resolve(modulePath, "package.json"), "utf-8"));
          const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
          const workspaceDeps = Object.entries(allDeps)
            .filter(([, ver]) => (ver as string).startsWith("workspace:"))
            .map(([name]) => name);
          return {
            dirName,
            packageName: pkg.name as string,
            path: modulePath,
            workspaceDeps,
            scripts: (pkg.scripts ?? {}) as Record<string, string>,
            os: pkg.os as string[] | undefined,
          };
        } catch (e) {
          if (e instanceof Error && "code" in e && e.code === "ENOENT") return null;
          throw e;
        }
      })
    )
  ).filter((value) => value !== null);
}
