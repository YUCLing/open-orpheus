import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { PROJECT_ROOT } from "../../../shared/paths.ts";
import { runBuildCommand } from "../../../shared/process.ts";
import { readModuleInfos } from "./discover.ts";
import { computeLayers } from "./layers.ts";
import { invokesNapi } from "./napi.ts";
import { isPlatformCompatible, resolvePlatformScript } from "./platform.ts";
import type { BuildTask } from "./types.ts";

/** Build every workspace module under `modules/`, honouring platform filters. */
export async function buildModules(): Promise<void> {
  const modulesDir = resolve(PROJECT_ROOT, "modules");
  const moduleNames = await readdir(modulesDir);
  const modules = await readModuleInfos(modulesDir, moduleNames);
  const layers = computeLayers(modules);
  const preferScript = process.env.PREFER_SCRIPT;
  const skipIfNoScript = process.env.SKIP_IF_NO_SCRIPT;
  // Packagers whose sandbox already ships the native toolchain (the Flatpak
  // SDK) set this so the `:${platform}` variants, which only exist to opt into
  // napi's glibc 2.17 cross toolchain, are not selected.
  const allowPlatformVariant = process.env.SKIP_PLATFORM_VARIANT !== "1";

  for (const layer of layers) {
    const tasks: BuildTask[] = [];
    for (const mod of layer) {
      if (!isPlatformCompatible(mod.os, process.platform)) {
        console.log(
          `Skipping module: ${mod.dirName} (${mod.packageName}) - os field [${mod.os?.join(", ") ?? ""}] does not include current platform "${process.platform}"`
        );
        continue;
      }
      const baseScript = preferScript || "build";
      const script = resolvePlatformScript(mod.scripts, baseScript, allowPlatformVariant);
      if (!script && skipIfNoScript) {
        console.log(
          `Skipping module: ${mod.dirName} (${mod.packageName}) - script "${baseScript}" not found`
        );
        continue;
      }
      const scriptToRun = script ?? "build";
      tasks.push({ module: mod, script: scriptToRun, command: mod.scripts[scriptToRun] ?? "" });
    }

    // napi builds contend for the cross-toolchain cache, so they are drained
    // one after another; the remaining builds still run concurrently, and in
    // parallel with the serialized napi queue.
    const napiTasks: BuildTask[] = [];
    const otherTasks: BuildTask[] = [];
    for (const task of tasks) {
      if (invokesNapi(task.command)) napiTasks.push(task);
      else otherTasks.push(task);
    }

    await Promise.all([Promise.all(otherTasks.map(runBuildTask)), runSequentially(napiTasks)]);
  }
}

async function runBuildTask({ module: mod, script }: BuildTask): Promise<void> {
  console.log(`Building module: ${mod.dirName} (${mod.packageName}) [${script}]`);
  const result = await runBuildCommand(mod.path, script);
  if (result.status !== 0) {
    console.error(`Failed to build module: ${mod.dirName}`);
    process.exit(1);
  }
}

async function runSequentially(tasks: BuildTask[]): Promise<void> {
  for (const task of tasks) {
    await runBuildTask(task);
  }
}
