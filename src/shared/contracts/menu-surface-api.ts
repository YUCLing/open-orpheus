import type {
  MenuChildOpenRequest,
  MenuMeasurement,
  MenuSurfaceConfig,
  MenuSurfaceId,
  MenuUpdate,
} from "@shared/types/menu-surface";

export interface MenuSurfaceContract {
  surface: {
    ready(): Promise<boolean>;
    getFont(): Promise<string | null>;
    reportSize(payload: { requestId: number } & MenuMeasurement): Promise<boolean>;
    visible(payload: { requestId: number }): Promise<boolean>;
    itemClick(menuId: string | null): Promise<void>;
    btnClick(btnId: string): Promise<void>;
    close(): Promise<void>;
    openChild(payload: MenuChildOpenRequest): Promise<void>;
    closeChildren(parentId: MenuSurfaceId): Promise<void>;
  };

  events: {
    surface: {
      prepare(callback: (config: MenuSurfaceConfig & { requestId: number }) => void): void;
      update(callback: (update: MenuUpdate) => void): void;
      show(callback: (payload: { requestId: number }) => void): void;
      cursor(
        callback: (payload: { requestId: number; x: number; y: number; fallback?: boolean }) => void
      ): void;
    };
  };
}
