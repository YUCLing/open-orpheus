import type {
  MenuMeasurement,
  MenuSurfaceConfig,
  MenuSurfaceId,
  MenuUpdate,
} from "@shared/types/menu-surface";

/**
 * One menu surface. The implementation owns the `WebContentsView` and the
 * `BaseWindow`; the open path is external.
 */
export interface MenuSurface {
  readonly id: MenuSurfaceId;

  /** Reset internal state and apply the presentation config; returns the measured size. */
  prepare(config: MenuSurfaceConfig, timeoutMs?: number): Promise<MenuMeasurement>;

  present(): void;

  /** Resolves when the renderer acknowledges visible. */
  show(timeoutMs?: number): Promise<void>;
  isFocused(): boolean;

  focus(): void;

  setPosition(x: number, y: number): void;

  getBounds(): { x: number; y: number; width: number; height: number } | null;

  update(update: MenuUpdate): void;

  /** Idempotent; destroys the window and releases view ownership. */
  close(): void;
}

export interface SurfaceFactory {
  /** Create a bare, loaded, mode-agnostic surface. No menu config applied yet. */
  create(): Promise<MenuSurface>;
}
