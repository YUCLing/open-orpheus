import { describe, expect, it } from "vitest";

import { patchById } from "@main/windows/menu/types";

type Item = Parameters<typeof patchById>[0][number];

function item(menu_id: string, children?: Item[]): Item {
  return { menu_id, children } as Item;
}

describe("patchById", () => {
  it("replaces a top-level item", () => {
    const items = [item("a"), item("b")];
    const patch = item("b", [item("child")]);

    expect(patchById(items, patch)).toBe(true);
    expect(items[1]).toBe(patch);
    expect(items[0].menu_id).toBe("a");
  });

  it("replaces a nested item", () => {
    const target = item("target");
    const items = [item("a", [item("b", [target])])];
    const patch = item("target");

    expect(patchById(items, patch)).toBe(true);
    expect(items[0].children![0].children![0]).toBe(patch);
  });

  it("stops at the first match", () => {
    const first = item("dup");
    const second = item("dup");
    const patch = item("dup");
    const items = [first, second];

    expect(patchById(items, patch)).toBe(true);
    expect(items[0]).toBe(patch);
    expect(items[1]).toBe(second);
  });

  it("returns false and leaves the tree untouched when there is no match", () => {
    const items = [item("a", [item("b")])];
    const snapshot = JSON.stringify(items);

    expect(patchById(items, item("missing"))).toBe(false);
    expect(JSON.stringify(items)).toBe(snapshot);
  });

  it("handles an empty list", () => {
    expect(patchById([], item("a"))).toBe(false);
  });
});
