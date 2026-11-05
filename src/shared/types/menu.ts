import type { BtnImages } from "./dui";

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
  raw_text?: string;
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
