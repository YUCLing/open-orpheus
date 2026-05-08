import type { BtnImages } from "$bridge/contracts/menu-api";

export interface MenuItemBtn {
  id: string;
  images: BtnImages | null;
  enable: boolean;
}

export interface MenuItem {
  text: string;
  menu: boolean;
  enable: boolean;
  separator: boolean;
  children: MenuItem[] | null;
  hotkey?: string;
  image_color: string;
  image_path?: string;
  check_image_path?: string;
  menu_id: string | null;
  style?: string;
  btns?: MenuItemBtn[];
}

export type {
  BtnState,
  BtnImages,
  ElementTemplate,
  LayoutNode,
} from "$bridge/contracts/menu-api";
