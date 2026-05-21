export interface LyricWord {
  text: string;
  start_time: number;
  duration: number;
}

export interface LyricLine {
  start_time: number;
  end_time: number;
  words: LyricWord[];
}

export type Lyrics = LyricLine[];

export type LyricsType = "regular" | "per-word" | "translate" | "roma";
export type LyricsStore = { regular: Lyrics } & Partial<
  Record<LyricsType, Lyrics>
>;

export type LyricsUpdateEvent = CustomEvent<LyricsStore | null>;
export type LyricsSloganUpdateEvent = CustomEvent<string | null>;
export type LyricsPlayStateUpdateEvent = CustomEvent<boolean>;
export type LyricsTimeUpdateEvent = CustomEvent<number>;
