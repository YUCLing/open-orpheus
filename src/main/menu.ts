import {
  Menu,
  MenuItem,
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
  children: null; // TODO: Confirm if this is always null
  hotkey?: string;
  image_color: string;
  image_path?: string;
  menu_id: string | null;
};

export type AppMenu = AppMenuItem[];

export async function appMenuItemToMenuItem(
  webContent: WebContents,
  item: AppMenuItem,
  menuId: number
): Promise<MenuItem> {
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
  return new MenuItem({
    id: item.menu_id || undefined,
    label: item.text,
    enabled: item.enable,
    type: item.separator ? "separator" : "normal",
    submenu: item.menu ? [] : undefined, // TODO: Confirm if this is always empty array when menu is true
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
  });
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
