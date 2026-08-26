import { resolve } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

async function runBuildCommand(modulePath: string, script: string) {
  return new Promise<{ status: number | null }>((resolve, reject) => {
    const buildProcess = spawn("pnpm", ["run", script], {
      cwd: modulePath,
      stdio: "inherit",
      shell: true,
    });

    buildProcess.on("error", (err) => {
      reject(err);
    });

    buildProcess.on("exit", (code) => {
      resolve({ status: code });
    });
  });
}

interface ModuleInfo {
  dirName: string;
  packageName: string;
  path: string;
  workspaceDeps: string[];
  scripts: Record<string, string>;
  os?: string[];
}

async function readModuleInfos(
  modulesDir: string,
  moduleNames: string[]
): Promise<ModuleInfo[]> {
  return (
    await Promise.all(
      moduleNames.map(async (dirName) => {
        try {
          const modulePath = resolve(modulesDir, dirName);
          const pkg = JSON.parse(
            await readFile(resolve(modulePath, "package.json"), "utf-8")
          );
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
          if (e instanceof Error && "code" in e && e.code === "ENOENT")
            return null;
          throw e;
        }
      })
    )
  ).filter((value) => value !== null);
}

function computeLayers(modules: ModuleInfo[]): ModuleInfo[][] {
  const nameToModule = new Map(modules.map((m) => [m.packageName, m]));
  const layerCache = new Map<string, number>();
  const visiting = new Set<string>();

  function getLayer(mod: ModuleInfo): number {
    if (layerCache.has(mod.packageName))
      return layerCache.get(mod.packageName)!;
    if (visiting.has(mod.packageName)) {
      throw new Error(
        `Circular dependency detected involving ${mod.packageName}`
      );
    }
    visiting.add(mod.packageName);
    let maxDepLayer = -1;
    for (const dep of mod.workspaceDeps) {
      const depMod = nameToModule.get(dep);
      if (depMod) maxDepLayer = Math.max(maxDepLayer, getLayer(depMod));
    }
    visiting.delete(mod.packageName);
    const layer = maxDepLayer + 1;
    layerCache.set(mod.packageName, layer);
    return layer;
  }

  for (const mod of modules) getLayer(mod);

  const layers: ModuleInfo[][] = [];
  for (const mod of modules) {
    const l = layerCache.get(mod.packageName)!;
    while (layers.length <= l) layers.push([]);
    layers[l].push(mod);
  }
  return layers;
}

/**
 * Checks whether a module's `os` field is compatible with the given platform,
 * following npm's semantics:
 * - missing/empty list => compatible everywhere
 * - entries prefixed with `!` are negations (always incompatible if matched)
 * - positive entries restrict compatibility to those platforms
 */
function isPlatformCompatible(
  os: string[] | undefined,
  platform: string
): boolean {
  if (!os || os.length === 0) return true;
  const negated = new Set(
    os.filter((entry) => entry.startsWith("!")).map((entry) => entry.slice(1))
  );
  const positive = os.filter((entry) => !entry.startsWith("!"));
  if (negated.has(platform)) return false;
  if (positive.length > 0 && !positive.includes(platform)) return false;
  return true;
}

async function buildModules() {
  const modulesDir = resolve(import.meta.dirname, "../modules");
  const moduleNames = await readdir(modulesDir);
  const modules = await readModuleInfos(modulesDir, moduleNames);
  const layers = computeLayers(modules);
  const preferScript = process.env.PREFER_SCRIPT;
  const skipIfNoScript = process.env.SKIP_IF_NO_SCRIPT;

  for (const layer of layers) {
    await Promise.all(
      layer.map(async (mod) => {
        if (!isPlatformCompatible(mod.os, process.platform)) {
          console.log(
            `Skipping module: ${mod.dirName} (${mod.packageName}) - os field [${mod.os?.join(", ") ?? ""}] does not include current platform "${process.platform}"`
          );
          return;
        }
        const targetScript = preferScript || "build";
        if (!mod.scripts[targetScript]) {
          if (skipIfNoScript) {
            console.log(
              `Skipping module: ${mod.dirName} (${mod.packageName}) - script "${targetScript}" not found`
            );
            return;
          }
        }
        const script = mod.scripts[targetScript] ? targetScript : "build";
        console.log(
          `Building module: ${mod.dirName} (${mod.packageName}) [${script}]`
        );
        const result = await runBuildCommand(mod.path, script);
        if (result.status !== 0) {
          console.error(`Failed to build module: ${mod.dirName}`);
          process.exit(1);
        }
      })
    );
  }
}

buildModules();
