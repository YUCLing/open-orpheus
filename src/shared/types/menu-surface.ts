import type { ElementTemplate } from "./dui";
import type { AppMenuItem, MenuSkin } from "./menu";

export type MenuSurfaceId = string;
export type MenuHostKind = "window" | "overlay";
export type MenuSurfaceRole = "root" | "child";

export interface MenuAnchor {
  x: number;
  y: number;
}

export interface MenuMeasurement {
  width: number;
  height: number;
}

export interface MenuSurfaceConfig {
  id: MenuSurfaceId;
  host: MenuHostKind;
  role: MenuSurfaceRole;
  parentId: MenuSurfaceId | null;
  depth: number;
  anchor?: MenuAnchor;
  items: AppMenuItem[];
  templates: Record<string, ElementTemplate>;
  colors: MenuSkin;
  shadowInset?: number;
}

export interface MenuUpdate {
  items?: AppMenuItem[];
  patches?: AppMenuItem[];
  templates?: Record<string, ElementTemplate>;
  colors?: MenuSkin;
}

export interface MenuChildOpenRequest {
  parentId: MenuSurfaceId;
  depth: number;
  itemRect: { x: number; y: number; width: number; height: number };
  items: AppMenuItem[];
  templates: Record<string, ElementTemplate>;
}
