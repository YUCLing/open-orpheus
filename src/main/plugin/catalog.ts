import { PluginLayer } from "@shared/contracts/plugin-manager-api";

import type { DiscoveredPlugin } from "./discover";

/**
 * One discovered (or failed) plugin source, tagged with its trust layer.
 *
 * Candidates are grouped by layer before ids are resolved: a built-in always
 * owns its id, and duplicates within one layer are conflicts rather than an
 * arbitrary winner chosen by path ordering.
 */
export interface PluginCandidate {
  layer: PluginLayer;
  source: string;
  plugin?: DiscoveredPlugin;
  error?: unknown;
}

export enum PluginCatalogEntryKind {
  Selected = "selected",
  Conflict = "conflict",
}

export type PluginCatalogEntry =
  | {
      kind: PluginCatalogEntryKind.Selected;
      id: string;
      plugin: DiscoveredPlugin;
      shadowed: PluginCandidate[];
    }
  | {
      kind: PluginCatalogEntryKind.Conflict;
      id: string;
      layer: PluginLayer;
      candidates: PluginCandidate[];
    };

export interface PluginCatalog {
  selected: ReadonlyMap<string, DiscoveredPlugin>;
  entries: readonly PluginCatalogEntry[];
  invalid: readonly PluginCandidate[];
}

/** Resolve candidates into a deterministic, layered catalog. */
export function resolvePluginCatalog(candidates: readonly PluginCandidate[]): PluginCatalog {
  const invalid: PluginCandidate[] = [];
  const byId = new Map<string, { builtin: PluginCandidate[]; user: PluginCandidate[] }>();

  for (const candidate of candidates) {
    if (!candidate.plugin) {
      invalid.push(candidate);
      continue;
    }
    const id = candidate.plugin.metadata.id;
    let group = byId.get(id);
    if (!group) {
      group = { builtin: [], user: [] };
      byId.set(id, group);
    }
    if (candidate.layer === PluginLayer.Builtin) group.builtin.push(candidate);
    else group.user.push(candidate);
  }

  const selected = new Map<string, DiscoveredPlugin>();
  const entries: PluginCatalogEntry[] = [];

  for (const id of [...byId.keys()].sort()) {
    const group = byId.get(id)!;
    const builtins = sortCandidates(group.builtin);
    const users = sortCandidates(group.user);

    if (builtins.length > 1) {
      entries.push({
        kind: PluginCatalogEntryKind.Conflict,
        id,
        layer: PluginLayer.Builtin,
        candidates: builtins,
      });
      continue;
    }

    const builtin = builtins[0];
    if (builtin?.plugin) {
      selected.set(id, builtin.plugin);
      entries.push({
        kind: PluginCatalogEntryKind.Selected,
        id,
        plugin: builtin.plugin,
        shadowed: users,
      });
      continue;
    }

    if (users.length > 1) {
      entries.push({
        kind: PluginCatalogEntryKind.Conflict,
        id,
        layer: PluginLayer.User,
        candidates: users,
      });
      continue;
    }

    const user = users[0];
    if (user?.plugin) {
      selected.set(id, user.plugin);
      entries.push({
        kind: PluginCatalogEntryKind.Selected,
        id,
        plugin: user.plugin,
        shadowed: [],
      });
    }
  }

  return { selected, entries, invalid: [...invalid].sort(bySource) };
}

function sortCandidates(candidates: PluginCandidate[]): PluginCandidate[] {
  return [...candidates].sort(bySource);
}

function bySource(a: PluginCandidate, b: PluginCandidate): number {
  return a.source.localeCompare(b.source);
}
