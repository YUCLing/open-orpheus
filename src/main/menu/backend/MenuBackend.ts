import type { BrowserWindow } from "electron";

import type { ElementTemplate } from "@shared/types/dui";
import type { AppMenuItem, MenuSkin } from "@shared/types/menu";
import type { MenuAnchor, MenuUpdate } from "@shared/types/menu-surface";

export interface MenuBackendContext {
  readonly items: AppMenuItem[];
  readonly templates: Record<string, ElementTemplate>;
  readonly colors: MenuSkin;
  readonly parentWindow?: BrowserWindow;
  readonly shadowInset: number;
  readonly anchor: (MenuAnchor & { surfaceId?: string }) | null;

  onItemClick(menuId: string | null): void;
  onButtonClick(btnId: string): void;
  onClose(): void;
}

export interface MenuBackend {
  open(): Promise<void>;
  update(update: MenuUpdate): void;
  isFocused(): boolean;
  hasChildren(): boolean;
  close(): void | Promise<void>;
}

export class NoPopupAnchorError extends Error {
  constructor(readonly reason: string = "no-anchor") {
    super(`no native popup anchor: ${reason}`);
    this.name = "NoPopupAnchorError";
  }
}
