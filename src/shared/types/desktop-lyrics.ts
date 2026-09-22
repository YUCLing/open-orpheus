export enum TextAlignType {
  Left = "left",
  Center = "center",
  Right = "right",
}
export enum LineMode {
  Single = "single",
  Double = "double",
}
export enum ShowTranslate {
  None = "none",
  Translate = "translate",
  Roman = "roman",
}

export interface LyricGradient {
  top: string;
  bottom: string;
}

export interface LyricsStyle {
  font: {
    family: string;
    size: number;
    weight: string;
  };
  textAlign: [TextAlignType, TextAlignType];
  lineMode: LineMode;
  vertical: boolean;
  color: {
    notPlayed: LyricGradient;
    played: LyricGradient;
  };
  outline: {
    notPlayed: string;
    played: string;
  };
  dropShadow: boolean;
  showTranslate: ShowTranslate;
}

export interface DesktopLyricsPlayInfo {
  albumId: string;
  albumName: string;
  artistName: string;
  songName: string;
}
