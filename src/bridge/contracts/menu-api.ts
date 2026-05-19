import type { MenuSkin, MenuPullResult } from "$sharedTypes/menu";
import type {
  ElementTemplate,
  LayoutNode,
  BtnImages,
  BtnState,
} from "$sharedTypes/dui";

export type { MenuSkin };
export type { ElementTemplate, LayoutNode };
export type { BtnImages, BtnState };
export type { MenuPullResult };

export interface MenuContract {
  wayland: boolean;
  submenu: boolean;

  events: {
    update(callback: (items: unknown[]) => void): void;
  };

  pull(): Promise<MenuPullResult>;
  reportSize(width: number, height: number): Promise<void>;
  itemClick(menuId: string | null): Promise<void>;
  btnClick(btnId: string): Promise<void>;
  close(): Promise<void>;
  openSubmenu(
    items: unknown[],
    templates: Record<string, ElementTemplate>,
    x: number,
    y: number
  ): Promise<void>;
  closeSubmenu(): Promise<void>;
}
