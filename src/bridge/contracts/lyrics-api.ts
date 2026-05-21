import type { LyricsStore } from "$sharedTypes/lyrics";

export interface LyricsContract {
  events: {
    lyricsStoreUpdate(callback: (store: LyricsStore | null) => void): void;
    sloganUpdate(callback: (slogan: string | null) => void): void;
    playStateUpdate(callback: (state: boolean) => void): void;
    timeUpdate(callback: (time: number) => void): void;
  };
  requestFullUpdate(): Promise<void>;
}
