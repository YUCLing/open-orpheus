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

export async function appMenuItemToMenuItem(
  webContent: WebContents,
  item: AppMenuItem,
  parentId: number
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
        parentId
      );
    },
  });
}

export async function buildMenu(
  webContent: WebContents,
  items: AppMenuItem[],
  parentId: number
): Promise<Menu> {
  const menu = new Menu();
  for (const item of items) {
    const menuItem = await appMenuItemToMenuItem(webContent, item, parentId);
    menu.append(menuItem);
  }
  return menu;
}
