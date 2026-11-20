import { describe, expect, it } from "vitest";

import { PluginKind, PluginLayer } from "@shared/contracts/plugin-manager-api";

import {
  PluginCatalogEntryKind,
  resolvePluginCatalog,
  type PluginCandidate,
} from "../../../src/main/plugin/catalog";
import type { DiscoveredPlugin } from "../../../src/main/plugin/discover";

function plugin(id: string, kind: PluginKind, source: string): DiscoveredPlugin {
  return {
    metadata: { id, name: id, version: "1.0.0", realms: { main: "main/index.mjs" } },
    source,
    kind,
    entryPaths: { main: `${source}/main/index.mjs` },
    tree: {} as DiscoveredPlugin["tree"],
  };
}

function candidate(id: string, kind: PluginKind, source: string): PluginCandidate {
  return {
    layer: kind === PluginKind.Builtin ? PluginLayer.Builtin : PluginLayer.User,
    source,
    plugin: plugin(id, kind, source),
  };
}

describe("resolvePluginCatalog", () => {
  it("selects a unique built-in and shadows a user duplicate", () => {
    const catalog = resolvePluginCatalog([
      candidate("same", PluginKind.User, "/data/plugins/same"),
      candidate("same", PluginKind.Builtin, "/app/builtin-plugins/same"),
    ]);

    expect(catalog.selected.get("same")?.kind).toBe(PluginKind.Builtin);
    const [entry] = catalog.entries;
    expect(entry).toMatchObject({ kind: PluginCatalogEntryKind.Selected, id: "same" });
    if (entry.kind !== PluginCatalogEntryKind.Selected) throw new Error("expected selected");
    expect(entry.shadowed.map((shadowed) => shadowed.source)).toEqual(["/data/plugins/same"]);
  });

  it("never lets a user duplicate change which package owns a built-in id", () => {
    const catalog = resolvePluginCatalog([
      candidate("same", PluginKind.User, "/aaa/same"),
      candidate("same", PluginKind.Builtin, "/zzz/same"),
    ]);

    expect(catalog.selected.get("same")?.source).toBe("/zzz/same");
  });

  it("treats same-layer duplicates as a conflict with no selected plugin", () => {
    const catalog = resolvePluginCatalog([
      candidate("dup", PluginKind.User, "/data/plugins/b"),
      candidate("dup", PluginKind.User, "/data/plugins/a"),
    ]);

    expect(catalog.selected.has("dup")).toBe(false);
    const [entry] = catalog.entries;
    expect(entry).toMatchObject({
      kind: PluginCatalogEntryKind.Conflict,
      id: "dup",
      layer: PluginLayer.User,
    });
    if (entry.kind !== PluginCatalogEntryKind.Conflict) throw new Error("expected conflict");
    expect(entry.candidates.map((value) => value.source)).toEqual([
      "/data/plugins/a",
      "/data/plugins/b",
    ]);
  });

  it("reports duplicate built-ins as a conflict", () => {
    const catalog = resolvePluginCatalog([
      candidate("dup", PluginKind.Builtin, "/app/a"),
      candidate("dup", PluginKind.Builtin, "/app/b"),
    ]);

    expect(catalog.selected.size).toBe(0);
    expect(catalog.entries[0]).toMatchObject({
      kind: PluginCatalogEntryKind.Conflict,
      layer: PluginLayer.Builtin,
    });
  });

  it("selects a unique user plugin and keeps invalid candidates separate", () => {
    const catalog = resolvePluginCatalog([
      candidate("user.one", PluginKind.User, "/data/plugins/one"),
      {
        layer: PluginLayer.User,
        source: "/data/plugins/broken",
        error: new Error("bad metadata"),
      },
    ]);

    expect(catalog.selected.get("user.one")?.kind).toBe(PluginKind.User);
    expect(catalog.invalid.map((value) => value.source)).toEqual(["/data/plugins/broken"]);
  });

  it("sorts entries by id deterministically", () => {
    const catalog = resolvePluginCatalog([
      candidate("b", PluginKind.User, "/data/plugins/b"),
      candidate("a", PluginKind.User, "/data/plugins/a"),
    ]);

    expect(catalog.entries.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});
