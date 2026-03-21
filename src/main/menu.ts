import {
  Menu,
  MenuItem,
  MenuItemConstructorOptions,
  nativeImage,
  NativeImage,
} from "electron";
import { pngFromIco } from "./util";
import { loadFromOrpheusUrl } from "./orpheus";

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

export type AppMenu = AppMenuItem[];
export type AppMenuItemClickHandler = (
  itemMenuId: string | null,
  menuId: number
) => void;

async function appMenuItemToMenuItemOptions(
  item: AppMenuItem,
  menuId: number,
  onClick?: AppMenuItemClickHandler
): Promise<MenuItemConstructorOptions> {
  let icon: NativeImage | undefined = undefined;
  if (item.image_path) {
    try {
      const buf = await loadFromOrpheusUrl(item.image_path);
      const img = await pngFromIco(buf.content);
      icon = nativeImage.createFromBuffer(Buffer.from(img));
    } catch {
      /* empty */
    }
  }
  const options: MenuItemConstructorOptions = {
    id: item.menu_id || undefined,
    label: item.text,
    enabled: item.enable,
    type: item.separator ? "separator" : "normal",
    accelerator: item.hotkey,
    icon,
    click: onClick ? () => onClick(item.menu_id, menuId) : undefined,
  };
  return options;
}

export async function appMenuItemToMenuItem(
  item: AppMenuItem,
  menuId: number,
  onClick?: AppMenuItemClickHandler
): Promise<MenuItem> {
  const options = await appMenuItemToMenuItemOptions(item, menuId, onClick);
  if (item.children) {
    options.type = "submenu";
    options.submenu = [];
    for (const child of item.children) {
      options.submenu.push(
        await appMenuItemToMenuItemOptions(child, menuId, onClick)
      );
    }
  }
  return new MenuItem(options);
}

export async function buildMenu(
  items: AppMenuItem[],
  menuId: number,
  onClick?: AppMenuItemClickHandler
): Promise<Menu> {
  const menu = new Menu();
  for (const item of items) {
    const menuItem = await appMenuItemToMenuItem(item, menuId, onClick);
    menu.append(menuItem);
  }
  return menu;
}
