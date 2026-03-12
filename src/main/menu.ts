import {
  Menu,
  MenuItem,
  MenuItemConstructorOptions,
  nativeImage,
  NativeImage,
  WebContents,
} from "electron";
import { pngFromIco } from "./util";
import { loadFromOrpheusUrl } from "./orpheus";

export type AppMenuItem = {
  text: string;
  menu: boolean;
  enable: boolean;
  separator: boolean;
  children: AppMenuItem[] | null; // TODO: Confirm if this is always null
  hotkey?: string;
  image_color: string;
  image_path?: string;
  menu_id: string | null;
};

export type AppMenu = AppMenuItem[];

async function appMenuItemToMenuItemOptions(
  webContent: WebContents,
  item: AppMenuItem,
  menuId: number
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
    click: () => {
      webContent.send(
        "channel.call",
        "winhelper.onmenuclick",
        item.menu_id,
        menuId
      );
    },
  };
  return options;
}

export async function appMenuItemToMenuItem(
  webContent: WebContents,
  item: AppMenuItem,
  menuId: number
): Promise<MenuItem> {
  const options = await appMenuItemToMenuItemOptions(webContent, item, menuId);
  if (item.children) {
    options.type = "submenu";
    options.submenu = [];
    for (const child of item.children) {
      options.submenu.push(
        await appMenuItemToMenuItemOptions(webContent, child, menuId)
      );
    }
  }
  return new MenuItem(options);
}

export async function buildMenu(
  webContent: WebContents,
  items: AppMenuItem[],
  menuId: number
): Promise<Menu> {
  const menu = new Menu();
  for (const item of items) {
    const menuItem = await appMenuItemToMenuItem(webContent, item, menuId);
    menu.append(menuItem);
  }
  return menu;
}
