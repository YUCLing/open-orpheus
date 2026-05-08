import type { BtnImages } from "../skin/dui";

export type AppMenuItemBtn = {
  id: string;
  url: string;
  images?: BtnImages | null;
  enable: boolean;
};

export type AppMenuItem = {
  text: string;
  menu: boolean;
  enable: boolean;
  separator: boolean;
  children: AppMenuItem[] | null;
  hotkey?: string;
  image_color: string;
  image_path?: string;
  check_image_path?: string;
  menu_id: string | null;
  style?: string;
  btns?: AppMenuItemBtn[];
};

export type MenuSkin = {
  background: string;
  foreground: string;
  foregroundDisabled: string;
  separator: string;
  itemHover: string;
};

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
