import { captureCursorEnter, getPointerPosition } from "@open-orpheus/window";
import type { MenuSurfaceConfig } from "@shared/types/menu-surface";

import { DEFAULT_CURSOR_CAPTURE_TIMEOUT_MS } from "../constants";
import { BaseWindowMenuSurface } from "../surface/BaseWindowMenuSurface";
import { workaroundEnabled, WorkaroundFlags } from "../workaround";
import type { MenuBackend, MenuBackendContext } from "./MenuBackend";

/** Fullscreen Wayland overlay; the renderer owns the panel path. */
export class WaylandOverlayBackend implements MenuBackend {
  private surface: BaseWindowMenuSurface | null = null;
  private closed = false;

  constructor(private readonly context: MenuBackendContext) {}

  async open(): Promise<void> {
    if (this.closed) return;
    const surface = new BaseWindowMenuSurface(
      {
        onItemClick: (menuId) => this.context.onItemClick(menuId),
        onButtonClick: (btnId) => this.context.onButtonClick(btnId),
        onClose: () => this.context.onClose(),
        onOpenChild: () => {},
        onCloseChildren: () => {},
        onBlur: () => this.context.onClose(),
      },
      {
        route: "/menu-overlay",
        fullscreen: !workaroundEnabled(WorkaroundFlags.OverlayNoFullscreen),
        maximize:
          workaroundEnabled(WorkaroundFlags.OverlayNoFullscreen) &&
          !workaroundEnabled(WorkaroundFlags.OverlayNoMaximize),
        measure: false,
      }
    );
    this.surface = surface;

    try {
      const measurement = await surface.prepare(this.configFor(surface.id));
      surface.present();
      const capture = this.captureCursor(surface);
      const showing = surface.show();
      // Close or replacement can reject this while cursor capture is pending.
      void showing.catch(() => undefined);
      const position = await capture;
      if (!this.closed && this.surface === surface) surface.sendCursor(position);
      await showing;
      void measurement;
    } catch (error) {
      surface.close();
      this.surface = null;
      throw error;
    }
  }

  isFocused(): boolean {
    return this.surface?.isFocused() ?? false;
  }

  hasChildren(): boolean {
    return false;
  }

  update(update: Parameters<NonNullable<MenuBackend["update"]>>[0]): void {
    this.surface?.update(update);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.surface?.close();
    this.surface = null;
  }

  private configFor(id: string): MenuSurfaceConfig {
    return {
      id,
      host: "overlay",
      role: "root",
      parentId: null,
      depth: 0,
      items: this.context.items,
      templates: this.context.templates,
      colors: this.context.colors,
      shadowInset: 0,
    };
  }

  private async captureCursor(
    surface: BaseWindowMenuSurface
  ): Promise<{ x: number; y: number; fallback?: boolean }> {
    const entered = await captureCursorEnter(surface.id, DEFAULT_CURSOR_CAPTURE_TIMEOUT_MS);
    if (entered) return { x: entered[0], y: entered[1] };

    // The first enter can be missed when the overlay maps under the pointer.
    const current = getPointerPosition(surface.id);
    return current ? { x: current.x, y: current.y } : { x: 0, y: 0, fallback: true };
  }
}
