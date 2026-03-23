import { Menu } from "@open-orpheus/ui";

export type AppMenuItem = {
  text: string;
  menu: boolean;
  enable: boolean;
  separator: boolean;
  children: AppMenuItem[] | null;
  hotkey?: string;
  image_color: string;
  image_path?: string;
  menu_id: string | null;
};

export type AppMenu = Menu;
