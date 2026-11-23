import type { ModuleInfo } from "./types.ts";

/**
 * Group modules into build layers: every module comes after all workspace
 * modules it depends on, so layers can be built one after another while the
 * modules within a layer build concurrently.
 */
export function computeLayers(modules: ModuleInfo[]): ModuleInfo[][] {
  const nameToModule = new Map(modules.map((m) => [m.packageName, m]));
  const layerCache = new Map<string, number>();
  const visiting = new Set<string>();

  function getLayer(mod: ModuleInfo): number {
    if (layerCache.has(mod.packageName)) return layerCache.get(mod.packageName)!;
    if (visiting.has(mod.packageName)) {
      throw new Error(`Circular dependency detected involving ${mod.packageName}`);
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
