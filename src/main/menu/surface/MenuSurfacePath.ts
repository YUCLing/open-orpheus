import type { MenuSurface } from "./MenuSurface";
import type { MenuSurfaceId } from "@shared/types/menu-surface";

/**
 * The open menu surfaces, root -> leaf. Only one branch is ever open.
 *
 * This is separate from the menu item data tree.
 */
export class MenuSurfacePath {
  private readonly entries: MenuSurface[] = [];

  get surfaces(): readonly MenuSurface[] {
    return this.entries;
  }

  get leaf(): MenuSurface | null {
    return this.entries.at(-1) ?? null;
  }

  get size(): number {
    return this.entries.length;
  }

  get(id: MenuSurfaceId): MenuSurface | undefined {
    return this.entries.find((surface) => surface.id === id);
  }

  depthOf(id: MenuSurfaceId): number {
    return this.entries.findIndex((surface) => surface.id === id);
  }

  parentOf(id: MenuSurfaceId): MenuSurface | undefined {
    const index = this.depthOf(id);
    return index > 0 ? this.entries[index - 1] : undefined;
  }

  openRoot(surface: MenuSurface): void {
    if (this.entries.length !== 0) {
      throw new Error("cannot open a root surface while the path is not empty");
    }
    this.entries.push(surface);
  }

  /**
   * Append a child for `parentId`. Everything after the parent is truncated
   * first, so opening a sibling replaces the previous child path.
   */
  openChild(parentId: MenuSurfaceId, surface: MenuSurface): void {
    const parentIndex = this.depthOf(parentId);
    if (parentIndex < 0) {
      throw new Error(`cannot open child for unknown surface "${parentId}"`);
    }
    if (this.get(surface.id)) {
      throw new Error(`surface "${surface.id}" is already on the path`);
    }
    if (surface.id === parentId) {
      throw new Error("a surface cannot be its own parent");
    }
    this.entries.length = parentIndex + 1;
    this.entries.push(surface);
  }

  /**
   * Remove `id` and every descendant. Returns removed surfaces leaf-first so
   * callers can close them in teardown order.
   */
  closeFrom(id: MenuSurfaceId): MenuSurface[] {
    const index = this.depthOf(id);
    if (index < 0) return [];
    return this.entries.splice(index).reverse();
  }

  /** Remove everything, leaf-first. */
  closeAll(): MenuSurface[] {
    return this.entries.splice(0).reverse();
  }
}
