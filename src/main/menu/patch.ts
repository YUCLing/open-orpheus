import type { AppMenuItem } from "@shared/types/menu";

/** Replace the first item with the patch's menu_id, recursively. */
export function patchById(items: AppMenuItem[], patch: AppMenuItem): boolean {
  for (let i = 0; i < items.length; i++) {
    if (items[i].menu_id === patch.menu_id) {
      items[i] = patch;
      return true;
    }
    const children = items[i].children;
    if (children && patchById(children, patch)) return true;
  }
  return false;
}
