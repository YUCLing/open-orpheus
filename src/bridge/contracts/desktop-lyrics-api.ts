import type { LyricsData, LyricStyleConfig } from "../../../gui/src/lib/types";

export interface DesktopLyricsContract {
  events: {
    lyricsUpdate(callback: (data: LyricsData | null) => void): void;
    timeUpdate(
      callback: (data: { currentTime: number; playing: boolean }) => void
    ): void;
    styleUpdate(callback: (data: Partial<LyricStyleConfig>) => void): void;
    playStateChange(callback: (playing: boolean) => void): void;
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
