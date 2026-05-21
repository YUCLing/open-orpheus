import type { LyricStyleConfig } from "$sharedTypes/desktop-lyrics";

export interface DesktopLyricsContract {
  platform: NodeJS.Platform;
  events: {
    styleUpdate(callback: (data: Partial<LyricStyleConfig>) => void): void;
    setLocked(callback: (locked: boolean) => void): void;
  };
  requestFullUpdate(): Promise<void>;
  dragWindow(): Promise<void>;
  changeOrientation(): Promise<void>;
  performAction(action: string): Promise<void>;
}

export interface DesktopLyricsPreviewContract {
  requestInit(): Promise<{ style: Record<string, unknown>; text: string }>;
  ready(): Promise<void>;
}
