import { describe, expect, it, vi } from "vitest";

import { MenuSurfacePath } from "../../src/main/menu/surface/MenuSurfacePath";
import type { MenuSurface } from "../../src/main/menu/surface/MenuSurface";

function surface(id: string) {
  return {
    id,
    prepare: vi.fn(),
    present: vi.fn(),
    show: vi.fn(),
    update: vi.fn(),
    close: vi.fn(),
  } as unknown as MenuSurface;
}

describe("MenuSurfacePath", () => {
  it("opens a root and appends children in order", () => {
    const path = new MenuSurfacePath();
    const root = surface("root");
    const child = surface("child");
    path.openRoot(root);
    path.openChild("root", child);
    expect(path.surfaces.map((entry) => entry.id)).toEqual(["root", "child"]);
    expect(path.leaf).toBe(child);
    expect(path.depthOf("child")).toBe(1);
    expect(path.parentOf("child")).toBe(root);
  });

  it("truncates the previous branch when opening a sibling", () => {
    const path = new MenuSurfacePath();
    path.openRoot(surface("root"));
    path.openChild("root", surface("a"));
    path.openChild("a", surface("a1"));
    path.openChild("root", surface("b"));
    expect(path.surfaces.map((entry) => entry.id)).toEqual(["root", "b"]);
  });

  it("closes a surface and descendants leaf-first", () => {
    const path = new MenuSurfacePath();
    path.openRoot(surface("root"));
    path.openChild("root", surface("a"));
    path.openChild("a", surface("a1"));
    const removed = path.closeFrom("a");
    expect(removed.map((entry) => entry.id)).toEqual(["a1", "a"]);
    expect(path.surfaces.map((entry) => entry.id)).toEqual(["root"]);
  });

  it("ignores closeFrom for an unknown surface", () => {
    const path = new MenuSurfacePath();
    path.openRoot(surface("root"));
    expect(path.closeFrom("missing")).toEqual([]);
    expect(path.size).toBe(1);
  });

  it("closes everything leaf-first", () => {
    const path = new MenuSurfacePath();
    path.openRoot(surface("root"));
    path.openChild("root", surface("a"));
    expect(path.closeAll().map((entry) => entry.id)).toEqual(["a", "root"]);
    expect(path.size).toBe(0);
  });

  it("rejects duplicate and unknown children and a second root", () => {
    const path = new MenuSurfacePath();
    path.openRoot(surface("root"));
    expect(() => path.openRoot(surface("other"))).toThrow(/not empty/);
    expect(() => path.openChild("missing", surface("a"))).toThrow(/unknown/);
    path.openChild("root", surface("a"));
    expect(() => path.openChild("root", surface("a"))).toThrow(/already/);
  });
});
