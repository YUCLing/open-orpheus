import { screen } from "electron";
import type { Display } from "electron";

import {
  LayerShellLayer,
  isWindowKeyboardFocused,
  isWindowWaylandPopup,
  type LayerShellOptions,
} from "@open-orpheus/window";
import { toError } from "@shared/util";
import type { MenuSurfaceConfig, MenuSurfaceId, MenuUpdate } from "@shared/types/menu-surface";

import { CHILD_OPEN_TIMEOUT_MS, LAYER_CAPTURE_TIMEOUT_MS } from "../constants";
import { registerNativeWaylandPopup } from "../native-popup";
import { patchById } from "../patch";
import { MenuSurfacePath } from "../surface/MenuSurfacePath";
import { SurfacePool } from "../surface/SurfacePool";
import { BaseWindowMenuSurface } from "../surface/BaseWindowMenuSurface";
import { CaptureLayerSurface } from "../surface/CaptureLayerSurface";
import type { MenuSurface } from "../surface/MenuSurface";
import { ManagedWindow } from "../../window";
import type { MenuBackend, MenuBackendContext } from "./MenuBackend";

const MENU_NAMESPACE = "open-orpheus-menu";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Menu host for compositors with `zwlr_layer_shell_v1`.
 *
 * The cursor position comes from a short-lived transparent layer capture
 * window. The menu itself is an ordinary layer surface created at its final
 * bounds, and submenus are xdg_popups of it.
 */
export class WaylandLayerShellBackend implements MenuBackend {
  private readonly path = new MenuSurfacePath();
  private readonly pool: SurfacePool;
  private readonly childGenerations = new Map<string, number>();
  private readonly surfaceItems = new Map<MenuSurfaceId, MenuSurfaceConfig["items"]>();
  private readonly openingChildren = new Set<string>();
  private closed = false;
  private pendingRoot: MenuSurface | null = null;
  private root: MenuSurface | null = null;
  private captureSurface: CaptureLayerSurface | null = null;
  private focusLossPending = false;

  constructor(private readonly context: MenuBackendContext) {
    this.pool = new SurfacePool({ create: async () => this.createSurface() }, (error) =>
      LOGGER.warn({ err: toError(error) }, "Layer-shell menu surface refill failed")
    );
  }

  async open(): Promise<void> {
    if (this.closed) return;
    const layerShellVersion = ManagedWindow.layerShellVersion();
    if (layerShellVersion === null) {
      throw new Error("layer shell is not available");
    }
    if (layerShellVersion < 4) {
      throw new Error("layer shell on_demand keyboard focus is not available");
    }

    const surface = (await this.pool.acquire()) as BaseWindowMenuSurface;
    this.pendingRoot = surface;
    try {
      const measurementPromise = surface.prepare(
        this.configFor(surface.id, "root", null, 0, this.context.items)
      );
      const captureSurface = new CaptureLayerSurface();
      this.captureSurface = captureSurface;
      const capturePromise = captureSurface.capture(LAYER_CAPTURE_TIMEOUT_MS).finally(() => {
        if (this.captureSurface === captureSurface) this.captureSurface = null;
      });
      const [measurement, capture] = await Promise.all([measurementPromise, capturePromise]);
      if (this.closed) {
        surface.close();
        return;
      }
      if (!capture) throw new Error("layer-shell cursor capture failed");
      if (measurement.width <= 0 || measurement.height <= 0) {
        throw new Error("menu measured an empty size");
      }

      const display = screen.getAllDisplays().find((entry) => entry.id === capture.displayId);
      if (!display) {
        throw new Error(`layer-shell capture reported unknown display ${capture.displayId}`);
      }

      this.surfaceItems.set(surface.id, this.context.items);
      const options = this.layerOptions(capture, measurement, display);
      surface.setLayerShell(options);
      if (this.closed) {
        surface.close();
        return;
      }
      surface.present();
      this.path.openRoot(surface);
      this.pendingRoot = null;
      this.root = surface;
      await surface.show();
    } catch (error) {
      this.pendingRoot = null;
      this.root = null;
      this.captureSurface?.close();
      this.captureSurface = null;
      this.path.closeAll();
      surface.close();
      throw error;
    }
  }

  isFocused(): boolean {
    if (this.closed || this.root === null) return false;
    return this.path.surfaces.some((surface) => isWindowKeyboardFocused(surface.id));
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
    this.captureSurface?.close();
    this.captureSurface = null;

    this.pendingRoot?.close();
    this.pendingRoot = null;
    this.root = null;
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
      onOpenChild: (request) => this.openChild(request),
      onCloseChildren: (parentId) => this.closeChildren(parentId),
      onBlur: () => this.handleFocusLoss(),
    });
  }

  /** Convert the capture result and measured size into layer-surface options. */
  private layerOptions(
    cursor: { x: number; y: number },
    measurement: { width: number; height: number },
    display: Display
  ): LayerShellOptions {
    const inset = this.context.shadowInset;
    const contentWidth = Math.max(1, measurement.width - inset * 2);
    const contentHeight = Math.max(1, measurement.height - inset * 2);
    const bounds = display.bounds;
    const work = display.workArea;
    const workLeft = work.x - bounds.x;
    const workTop = work.y - bounds.y;
    const workRight = workLeft + work.width;
    const workBottom = workTop + work.height;

    const spaceRight = workRight - cursor.x;
    const spaceLeft = cursor.x - workLeft;
    const openRight =
      spaceRight >= contentWidth || (spaceLeft < contentWidth && spaceRight >= spaceLeft);
    const spaceBelow = workBottom - cursor.y;
    const spaceAbove = cursor.y - workTop;
    const openBelow =
      spaceBelow >= contentHeight || (spaceAbove < contentHeight && spaceBelow >= spaceAbove);

    const contentX = clamp(
      openRight ? cursor.x : cursor.x - contentWidth,
      workLeft,
      workRight - contentWidth
    );
    const contentY = clamp(
      openBelow ? cursor.y : cursor.y - contentHeight,
      workTop,
      workBottom - contentHeight
    );

    // The surface includes the transparent shadow margin on every side.
    const maxLeft = bounds.width - measurement.width;
    const maxTop = bounds.height - measurement.height;
    const marginLeft = openRight ? clamp(contentX - inset, 0, maxLeft) : 0;
    const marginRight = openRight
      ? 0
      : clamp(bounds.width - (contentX + contentWidth + inset), 0, maxLeft);
    const marginTop = openBelow ? clamp(contentY - inset, 0, maxTop) : 0;
    const marginBottom = openBelow
      ? 0
      : clamp(bounds.height - (contentY + contentHeight + inset), 0, maxTop);

    return {
      namespace: MENU_NAMESPACE,
      layer: LayerShellLayer.Overlay,
      output: display.id,
      anchorTop: openBelow,
      anchorBottom: !openBelow,
      anchorLeft: openRight,
      anchorRight: !openRight,
      width: measurement.width,
      height: measurement.height,
      marginTop,
      marginRight,
      marginBottom,
      marginLeft,
      exclusiveZone: -1,
      // on_demand is required for focus-loss dismissal: an exclusive layer
      // surface keeps keyboard focus until it unmaps.
      keyboardInteractivity: 2,
    };
  }

  private async openChild(request: {
    parentId: string;
    depth: number;
    itemRect: { x: number; y: number; width: number; height: number };
    items: MenuSurfaceConfig["items"];
    templates: MenuSurfaceConfig["templates"];
  }): Promise<void> {
    if (this.closed) return;
    const parent = this.path.get(request.parentId);
    if (!parent) {
      LOGGER.warn(
        { parentId: request.parentId },
        "Child layer menu parent is no longer on the path"
      );
      return;
    }
    const layerParent = parent === this.root;
    this.openingChildren.add(request.parentId);
    let opened = false;
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
        const config = this.configFor(
          child.id,
          "child",
          request.parentId,
          request.depth,
          request.items,
          request.templates
        );
        const measurement = await child.prepare(config, CHILD_OPEN_TIMEOUT_MS);
        this.surfaceItems.set(child.id, request.items);
        if (this.closed || this.childGenerations.get(request.parentId) !== generation) {
          child.close();
          return;
        }

        const inset = this.context.shadowInset;
        // The layer root has no xdg window geometry: its renderer coordinates
        // already are layer-surface coordinates. A popup parent is offset by
        // its shadow inset, so deeper submenus keep the old conversion.
        const anchor = layerParent
          ? {
              x: Math.max(0, Math.round(request.itemRect.x)),
              y: Math.max(0, Math.round(request.itemRect.y)),
            }
          : {
              x: Math.max(0, Math.round(request.itemRect.x) - inset),
              y: Math.max(0, Math.round(request.itemRect.y) - inset),
            };
        const anchorRectWidth = layerParent
          ? Math.max(1, Math.round(request.itemRect.x))
          : Math.max(1, anchor.x);
        const policy = registerNativeWaylandPopup(
          request.parentId,
          child.id,
          measurement.width,
          measurement.height,
          anchor,
          inset,
          anchorRectWidth
        );
        if (!policy.ok) {
          throw new Error(`native child popup policy was refused: ${policy.reason}`);
        }

        child.present();
        if (this.closed || this.childGenerations.get(request.parentId) !== generation) {
          child.close();
          return;
        }
        this.path.openChild(request.parentId, child);
        await child.show(CHILD_OPEN_TIMEOUT_MS);
        if (!isWindowWaylandPopup(child.id)) {
          throw new Error("native child popup conversion was not applied");
        }
        if (this.childGenerations.get(request.parentId) !== generation) {
          child.close();
        } else {
          opened = true;
        }
      } catch (error) {
        this.path.closeFrom(child.id);
        child.close();
        if (this.closed || this.childGenerations.get(request.parentId) !== generation) {
          return;
        }
        LOGGER.warn({ err: toError(error), parentId: request.parentId }, "Child layer menu failed");
        throw error;
      }
    } finally {
      this.openingChildren.delete(request.parentId);
      if (!opened && this.focusLossPending) {
        this.focusLossPending = false;
        this.handleFocusLoss();
      }
    }
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
    const parent = this.path.get(parentId);
    parent?.focus();
    setTimeout(() => {
      if (!this.closed) this.path.get(parentId)?.focus();
    }, 0);
  }

  private handleFocusLoss(): void {
    if (this.closed) return;
    // A child menu is opening; remember the blur and decide again when that
    // attempt finishes.
    if (this.openingChildren.size > 0) {
      this.focusLossPending = true;
      return;
    }
    const focused = this.path.surfaces.some((surface) => isWindowKeyboardFocused(surface.id));
    if (!focused) this.context.onClose();
  }

  private configFor(
    id: string,
    role: "root" | "child",
    parentId: string | null,
    depth: number,
    items = this.context.items,
    templates = this.context.templates
  ): MenuSurfaceConfig {
    return {
      id,
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
}
