import { screen } from "electron";
import { DesktopEnvironment, getCursorPosition, getDesktopEnvironment } from "@open-orpheus/window";
import { toError } from "@shared/util";
import type { MenuSurfaceConfig, MenuSurfaceId, MenuUpdate } from "@shared/types/menu-surface";

import { CHILD_OPEN_TIMEOUT_MS, SURFACE_BLUR_DISMISS_MS } from "../constants";
import { BaseWindowMenuSurface } from "../surface/BaseWindowMenuSurface";
import { patchById } from "../patch";
import { MenuSurfacePath } from "../surface/MenuSurfacePath";
import { SurfacePool } from "../surface/SurfacePool";
import type { MenuSurface } from "../surface/MenuSurface";
import type { MenuBackend, MenuBackendContext } from "./MenuBackend";

/** Desktop window host for X11, Windows and macOS. */
export class DesktopWindowBackend implements MenuBackend {
  private readonly path = new MenuSurfacePath();
  private readonly positions = new Map<MenuSurfaceId, { x: number; y: number }>();
  private readonly childGenerations = new Map<string, number>();
  private readonly surfaceItems = new Map<MenuSurfaceId, MenuSurfaceConfig["items"]>();
  private readonly openingChildren = new Set<string>();
  private lastChildCloseAt = 0;
  private readonly pool: SurfacePool;
  private closed = false;
  private pendingRoot: MenuSurface | null = null;
  private blurTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly context: MenuBackendContext) {
    this.pool = new SurfacePool({ create: async () => this.createSurface() }, (error) =>
      LOGGER.warn({ err: toError(error) }, "Desktop menu surface refill failed")
    );
  }

  async open(): Promise<void> {
    const surface = (await this.pool.acquire()) as BaseWindowMenuSurface;
    this.pendingRoot = surface;
    try {
      const measurement = await surface.prepare(
        this.configFor(surface.id, "root", null, 0, this.context.items)
      );
      if (this.closed) {
        surface.close();
        return;
      }
      this.surfaceItems.set(surface.id, this.context.items);
      const cursor = this.cursorPoint();
      const display = screen.getDisplayNearestPoint(cursor);
      const { x, y, width, height } = display.workArea;
      const onBottom = cursor.y > y + height / 2;
      const point = {
        x: Math.min(Math.max(cursor.x, x), x + Math.max(0, width - measurement.width)),
        y: Math.min(
          Math.max(onBottom ? cursor.y - measurement.height : cursor.y, y),
          y + Math.max(0, height - measurement.height)
        ),
      };

      if (this.closed) {
        surface.close();
        return;
      }
      surface.present();
      surface.setPosition(point.x, point.y);
      if (this.closed) {
        surface.close();
        return;
      }
      this.path.openRoot(surface);
      this.pendingRoot = null;
      this.positions.set(surface.id, point);
      await surface.show();
    } catch (error) {
      this.pendingRoot = null;
      surface.close();
      this.path.closeAll();
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
    for (const surface of this.path.closeAll()) {
      this.surfaceItems.delete(surface.id);
      surface.close();
    }
    this.positions.clear();
    await this.pool.close();
  }

  private createSurface(): MenuSurface {
    return new BaseWindowMenuSurface({
      onItemClick: (menuId) => this.context.onItemClick(menuId),
      onButtonClick: (btnId) => this.context.onButtonClick(btnId),
      onClose: () => this.context.onClose(),
      onOpenChild: (request) => this.openChild(request),
      onCloseChildren: (parentId) => this.closeChildren(parentId),
      onBlur: () => this.scheduleBlurClose(),
      onMeasurement: (surfaceId, measurement) => this.constrainPosition(surfaceId, measurement),
    });
  }

  private async openChild(request: {
    parentId: string;
    depth: number;
    itemRect: { x: number; y: number; width: number; height: number };
    items: MenuSurfaceConfig["items"];
    templates: MenuSurfaceConfig["templates"];
  }): Promise<void> {
    const parent = this.path.get(request.parentId);
    const parentPosition = this.positions.get(request.parentId);
    if (!parent || !parentPosition || this.closed) return;

    this.openingChildren.add(request.parentId);
    try {
      this.closeChildren(request.parentId);
      const generation = (this.childGenerations.get(request.parentId) ?? 0) + 1;
      this.childGenerations.set(request.parentId, generation);

      const child = (await this.pool.acquire()) as BaseWindowMenuSurface;
      try {
        if (this.closed || this.childGenerations.get(request.parentId) !== generation) {
          child.close();
          return;
        }
        const measurement = await child.prepare(
          this.configFor(child.id, "child", request.parentId, request.depth, request.items),
          CHILD_OPEN_TIMEOUT_MS
        );
        this.surfaceItems.set(child.id, request.items);
        if (this.closed || this.childGenerations.get(request.parentId) !== generation) {
          child.close();
          return;
        }
        const display = screen.getDisplayNearestPoint({ x: parentPosition.x, y: parentPosition.y });
        const { x, y, width, height } = display.workArea;
        let childX = parentPosition.x + request.itemRect.x;
        let childY = parentPosition.y + request.itemRect.y;
        if (childX + measurement.width > x + width) {
          childX = parentPosition.x - measurement.width;
        }
        childY = Math.min(Math.max(childY, y), y + Math.max(0, height - measurement.height));
        const point = {
          x: Math.min(Math.max(childX, x), x + Math.max(0, width - measurement.width)),
          y: childY,
        };

        if (!this.isFocused()) {
          child.close();
          return;
        }
        child.present();
        child.setPosition(point.x, point.y);
        if (this.closed || this.childGenerations.get(request.parentId) !== generation) {
          child.close();
          return;
        }
        this.path.openChild(request.parentId, child);
        this.positions.set(child.id, point);
        await child.show(CHILD_OPEN_TIMEOUT_MS);
        if (this.childGenerations.get(request.parentId) !== generation) {
          child.close();
        }
      } catch (error) {
        this.path.closeFrom(child.id);
        child.close();
        if (this.closed || this.childGenerations.get(request.parentId) !== generation) {
          return;
        }
        LOGGER.warn({ err: toError(error), parentId: request.parentId }, "Child menu failed");
        throw error;
      }
    } finally {
      this.openingChildren.delete(request.parentId);
    }
  }

  private constrainPosition(
    surfaceId: MenuSurfaceId,
    measurement: { width: number; height: number }
  ): void {
    const surface = this.path.get(surfaceId);
    const position = this.positions.get(surfaceId);
    if (!surface || !position) return;
    const display = screen.getDisplayNearestPoint(position);
    const { x, y, width, height } = display.workArea;
    const next = {
      x: Math.min(Math.max(position.x, x), x + Math.max(0, width - measurement.width)),
      y: Math.min(Math.max(position.y, y), y + Math.max(0, height - measurement.height)),
    };
    this.positions.set(surfaceId, next);
    surface.setPosition(next.x, next.y);
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
      this.positions.delete(surface.id);
      this.surfaceItems.delete(surface.id);
      surface.close();
    }
    this.lastChildCloseAt = Date.now();
    const parentSurface = this.path.get(parentId);
    parentSurface?.focus();
    setTimeout(() => {
      if (!this.closed) this.path.get(parentId)?.focus();
    }, 0);
  }

  private configFor(
    id: string,
    role: "root" | "child",
    parentId: string | null,
    depth: number,
    items: MenuSurfaceConfig["items"]
  ): MenuSurfaceConfig {
    return {
      id,
      host: "window",
      role,
      parentId,
      depth,
      items,
      templates: this.context.templates,
      colors: this.context.colors,
      shadowInset: 0,
    };
  }

  private cursorPoint(): { x: number; y: number } {
    let cursor = screen.getCursorScreenPoint();
    if (getDesktopEnvironment() === DesktopEnvironment.X11) {
      const native = getCursorPosition();
      if (native) {
        cursor = screen.screenToDipPoint({ x: native[0], y: native[1] });
      }
    }
    return cursor;
  }
}
