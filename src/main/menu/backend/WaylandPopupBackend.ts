import { screen } from "electron";

import { ManagedWindow } from "../../window";
import { toError } from "@shared/util";
import type { MenuSurfaceConfig, MenuSurfaceId, MenuUpdate } from "@shared/types/menu-surface";
import { isWindowWaylandPopup } from "@open-orpheus/window";

import { CHILD_OPEN_TIMEOUT_MS, SURFACE_BLUR_DISMISS_MS } from "../constants";
import { registerNativeWaylandPopup } from "../native-popup";
import { patchById } from "../patch";
import { SurfacePool } from "../surface/SurfacePool";
import { MenuSurfacePath } from "../surface/MenuSurfacePath";
import { BaseWindowMenuSurface } from "../surface/BaseWindowMenuSurface";
import type { MenuSurface } from "../surface/MenuSurface";
import { NoPopupAnchorError, type MenuBackend, type MenuBackendContext } from "./MenuBackend";

/**
 * Native Wayland popup host. The backend owns the surface path; the renderer
 * never sees it.
 */
export class WaylandPopupBackend implements MenuBackend {
  private readonly path = new MenuSurfacePath();
  private readonly pool: SurfacePool;
  private readonly childGenerations = new Map<string, number>();
  private readonly surfaceItems = new Map<MenuSurfaceId, MenuSurfaceConfig["items"]>();
  private readonly openingChildren = new Set<string>();
  private lastChildCloseAt = 0;
  private closed = false;
  private pendingRoot: MenuSurface | null = null;
  private blurTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly context: MenuBackendContext) {
    this.pool = new SurfacePool({ create: async () => this.createSurface() }, (error) =>
      LOGGER.warn({ err: toError(error) }, "Menu surface refill failed")
    );
  }

  async open(): Promise<void> {
    const anchor = this.context.anchor;
    if (!anchor) throw new NoPopupAnchorError();

    const surface = await this.pool.acquire();
    this.pendingRoot = surface;
    try {
      const measurement = await surface.prepare(this.configFor(surface, "root", null, 0));
      if (this.closed) {
        surface.close();
        return;
      }
      this.surfaceItems.set(surface.id, this.context.items);
      const parentId = this.parentWindowId();
      const policy = registerNativeWaylandPopup(
        parentId,
        surface.id,
        measurement.width,
        measurement.height,
        { x: anchor.x, y: anchor.y },
        this.context.shadowInset
      );
      if (!policy.ok) {
        throw new Error(`native popup policy was refused: ${policy.reason}`);
      }

      if (this.closed) {
        surface.close();
        return;
      }
      surface.present();
      if (this.closed) {
        surface.close();
        return;
      }
      this.path.openRoot(surface);
      this.pendingRoot = null;
      await surface.show();
      if (!isWindowWaylandPopup(surface.id)) {
        throw new Error("native popup conversion was not applied");
      }
    } catch (error) {
      this.pendingRoot = null;
      this.path.closeAll();
      surface.close();
      throw error;
    }
  }

  isFocused(): boolean {
    return this.path.surfaces.some((surface) => surface.isFocused());
  }

  hasChildren(): boolean {
    return this.openingChildren.size > 0 || this.path.surfaces.length > 1;
  }

  update(update: MenuUpdate): void {
    for (const [index, surface] of this.path.surfaces.entries()) {
      const current = this.surfaceItems.get(surface.id);
      if (!current) continue;
      let items = current;
      if (index === 0 && update.items) {
        items = update.items;
      } else if (update.patches) {
        for (const patch of update.patches) patchById(items, patch);
      }
      this.surfaceItems.set(surface.id, items);
      surface.update({ items, templates: update.templates, colors: update.colors });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.pendingRoot?.close();
    this.pendingRoot = null;
    if (this.blurTimer !== null) {
      clearTimeout(this.blurTimer);
      this.blurTimer = null;
    }
    this.childGenerations.clear();
    for (const surface of this.path.closeAll()) {
      this.surfaceItems.delete(surface.id);
      surface.close();
    }
    await this.pool.close();
  }

  private createSurface(): MenuSurface {
    return new BaseWindowMenuSurface({
      onItemClick: (menuId) => this.context.onItemClick(menuId),
      onButtonClick: (btnId) => this.context.onButtonClick(btnId),
      onClose: () => this.context.onClose(),
      onOpenChild: (request) => this.openChild(request.parentId, request),
      onCloseChildren: (parentId) => this.closeChildren(parentId),
      onBlur: () => this.scheduleBlurClose(),
    });
  }

  private async openChild(
    parentId: string,
    request: {
      parentId: string;
      depth: number;
      itemRect: { x: number; y: number; width: number; height: number };
      items: MenuSurfaceConfig["items"];
      templates: MenuSurfaceConfig["templates"];
    }
  ): Promise<void> {
    if (this.closed) return;
    const parent = this.path.get(request.parentId);
    if (!parent) {
      LOGGER.warn({ parentId }, "Child popup parent is no longer on the path");
      return;
    }

    this.openingChildren.add(request.parentId);
    try {
      // Close the old subtree first so a failed replacement cannot leave it open.
      this.closeChildren(request.parentId);
      const generation = (this.childGenerations.get(parentId) ?? 0) + 1;
      this.childGenerations.set(parentId, generation);

      const child = await this.pool.acquire();
      try {
        if (this.closed || this.childGenerations.get(parentId) !== generation) {
          child.close();
          return;
        }
        const config = this.configFor(
          child,
          "child",
          request.parentId,
          request.depth,
          request.items,
          request.templates
        );
        const measurement = await child.prepare(config, CHILD_OPEN_TIMEOUT_MS);
        this.surfaceItems.set(child.id, request.items);
        if (this.closed || this.childGenerations.get(parentId) !== generation) {
          child.close();
          return;
        }
        const inset = this.context.shadowInset;
        const anchor = {
          x: Math.max(0, Math.round(request.itemRect.x) - inset),
          y: Math.max(0, Math.round(request.itemRect.y) - inset),
        };
        const policy = registerNativeWaylandPopup(
          request.parentId,
          child.id,
          measurement.width,
          measurement.height,
          anchor,
          inset,
          Math.max(1, anchor.x)
        );
        if (!policy.ok) {
          throw new Error(`native child popup policy was refused: ${policy.reason}`);
        }

        child.present();
        if (this.closed || this.childGenerations.get(parentId) !== generation) {
          child.close();
          return;
        }
        this.path.openChild(request.parentId, child);
        await child.show(CHILD_OPEN_TIMEOUT_MS);
        if (!isWindowWaylandPopup(child.id)) {
          throw new Error("native child popup conversion was not applied");
        }
        if (this.childGenerations.get(parentId) !== generation) {
          child.close();
          return;
        }
      } catch (error) {
        this.path.closeFrom(child.id);
        child.close();
        if (this.closed || this.childGenerations.get(parentId) !== generation) {
          return;
        }
        LOGGER.warn({ err: toError(error), parentId, childId: child.id }, "Child popup failed");
        throw error;
      }
    } finally {
      this.openingChildren.delete(request.parentId);
    }
  }

  private scheduleBlurClose(retry = false): void {
    if (this.blurTimer !== null) clearTimeout(this.blurTimer);
    const delay = retry ? 300 : SURFACE_BLUR_DISMISS_MS;
    this.blurTimer = setTimeout(() => {
      this.blurTimer = null;
      const focused = this.isFocused();
      const opening = this.openingChildren.size > 0;
      if (this.closed || focused) return;
      if (opening) {
        this.scheduleBlurClose(true);
        return;
      }
      if (!retry) {
        const overMenu = this.cursorOverMenu();
        const recentChildClose =
          this.path.surfaces.length === 1 && Date.now() - this.lastChildCloseAt < 300;
        if (overMenu || recentChildClose) {
          this.scheduleBlurClose(true);
          return;
        }
      }
      this.context.onClose();
    }, delay);
  }

  private cursorOverMenu(): boolean {
    const point = screen.getCursorScreenPoint();
    return this.path.surfaces.some((surface) => {
      const bounds = surface.getBounds();
      return Boolean(
        bounds &&
        point.x >= bounds.x &&
        point.x < bounds.x + bounds.width &&
        point.y >= bounds.y &&
        point.y < bounds.y + bounds.height
      );
    });
  }

  private closeChildren(parentId: string): void {
    this.childGenerations.set(parentId, (this.childGenerations.get(parentId) ?? 0) + 1);
    const index = this.path.depthOf(parentId);
    if (index < 0) return;
    const child = this.path.surfaces[index + 1];
    if (!child) return;
    for (const surface of this.path.closeFrom(child.id)) {
      this.surfaceItems.delete(surface.id);
      surface.close();
    }
    this.lastChildCloseAt = Date.now();
    const parent = this.path.get(parentId);
    parent?.focus();
    setTimeout(() => {
      if (!this.closed) this.path.get(parentId)?.focus();
    }, 0);
  }

  private configFor(
    surface: MenuSurface,
    role: "root" | "child",
    parentId: string | null,
    depth: number,
    items = this.context.items,
    templates = this.context.templates
  ): MenuSurfaceConfig {
    return {
      id: surface.id,
      host: "window",
      role,
      parentId,
      depth,
      items,
      templates,
      colors: this.context.colors,
      shadowInset: this.context.shadowInset,
    };
  }

  private parentWindowId(): string {
    if (!this.context.parentWindow) throw new Error("popup parent window is missing");
    const managed = ManagedWindow.fromBrowserWindow(this.context.parentWindow);
    if (!managed) throw new Error("popup parent window is not managed");
    return managed.id;
  }
}
