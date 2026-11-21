import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import { PluginKind } from "@shared/contracts/plugin-manager-api";
import { toError } from "@shared/util";

import { parsePluginMetadata, type PluginMetadata } from "./metadata";
import { openPluginTree, type PluginTree } from "./tree";

/** A directory to scan for plugins, and the kind assigned to its children. */
export interface PluginLocation {
  dir: string;
  kind: PluginKind;
}

/** A discovered plugin source path and its kind. */
export interface PluginSource {
  source: string;
  kind: PluginKind;
}

/** A plugin tree that has metadata but whose main module has not been imported. */
export interface DiscoveredPlugin {
  metadata: PluginMetadata;
  /** Original directory or asar path. */
  source: string;
  /** Whether this plugin ships with the app or was installed by the user. */
  kind: PluginKind;
  /** Absolute paths to each declared realm's entry. */
  entryPaths: {
    main: string;
    preload?: string;
  };
  tree: PluginTree;
}

/**
 * List plugin sources in the given locations.
 *
 * A source is an immediate child directory or a `*.asar` file. Hidden entries
 * are skipped.
 */
export async function discoverPluginSources(locations: PluginLocation[]): Promise<PluginSource[]> {
  const sources: PluginSource[] = [];

  for (const location of locations) {
    let entries: Dirent[];
    try {
      entries = await readdir(location.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(location.dir, entry.name);
      if (entry.isDirectory()) {
        sources.push({ source: fullPath, kind: location.kind });
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".asar")) {
        sources.push({ source: fullPath, kind: location.kind });
      }
    }
  }

  return sources.sort((a, b) => a.source.localeCompare(b.source));
}

/** Open a source, validate its metadata, and resolve the main entry. */
export async function loadDiscoveredPlugin(
  source: string,
  kind: PluginKind = PluginKind.User
): Promise<DiscoveredPlugin> {
  const tree = await openPluginTree(source);

  const raw = await tree.readFile("metadata.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid metadata.json in ${source}: ${toError(error).message}`);
  }

  const metadata = parsePluginMetadata(parsed, source);

  const entryPaths: DiscoveredPlugin["entryPaths"] = {
    main: path.join(source, metadata.realms.main),
  };
  if (metadata.realms.preload) {
    entryPaths.preload = path.join(source, metadata.realms.preload);
  }

  for (const [realm, entryPath] of Object.entries(entryPaths)) {
    const entry = await stat(entryPath).catch(() => null);
    if (!entry?.isFile()) {
      throw new Error(`Plugin ${metadata.id} is missing its ${realm} entry "${entryPath}"`);
    }
  }

  return { metadata, source, kind, entryPaths, tree };
}
