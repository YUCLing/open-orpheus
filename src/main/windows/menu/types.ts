import type { AppMenuItem } from "$sharedTypes/menu";

export type MenuClickHandler = (menuId: string | null) => void;

export function patchById(items: AppMenuItem[], patch: AppMenuItem): boolean {
  for (let i = 0; i < items.length; i++) {
    if (items[i].menu_id === patch.menu_id) {
      items[i] = patch;
      return true;
    }
    if (items[i].children && patchById(items[i].children!, patch)) {
      return true;
    }
  }
  return false;
}
