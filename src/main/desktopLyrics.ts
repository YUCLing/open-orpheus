import { ipcMain } from "electron";
import { LyricsWindow, type LyricsStyleDto } from "@open-orpheus/ui";
import { getApp } from "./ui";
import { parseLrc } from "./lyrics";

let lyricsWindow: LyricsWindow | null = null;

/** Parse a 6-char hex color string ("rrggbb") into [r, g, b]. */
function hexToRgb(hex: string): [number, number, number] | undefined {
  if (!hex || hex.length !== 6) return undefined;
  const n = parseInt(hex, 16);
  if (isNaN(n)) return undefined;
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * Convert the NCM-format LyricStyle (hex color strings, etc.)
 * into the DTO expected by the native lyrics window.
 */
function convertStyle(ncm: Record<string, unknown>): LyricsStyleDto {
  const dto: LyricsStyleDto = {};

  dto.not_played_top = hexToRgb(ncm.lrcColorNotPlayedTop as string);
  dto.not_played_bottom = hexToRgb(ncm.lrcColorNotPlayedBottom as string);
  dto.played_top = hexToRgb(ncm.lrcColorPlayedTop as string);
  dto.played_bottom = hexToRgb(ncm.lrcColorPlayedBottom as string);
  dto.outline_color_not_played = hexToRgb(ncm.outlineColorNotPlayed as string);
  dto.outline_color_played = hexToRgb(ncm.outlineColorPlayed as string);

  const shadow = ncm.outlineShadow as boolean[] | undefined;
  if (shadow) {
    dto.shadow_enabled = shadow[0] || shadow[1];
  }

  const fontName = ncm.lrcFontName as string | undefined;
  if (fontName) {
    dto.font_family = fontName;
  }
  const fontSize = ncm.lrcFontSize as string | undefined;
  if (fontSize) {
    const size = parseFloat(fontSize);
    if (!isNaN(size)) dto.font_size = size;
  }
  if (typeof ncm.lrcFontBold === "boolean") {
    dto.bold = ncm.lrcFontBold;
  }

  const textAlign = ncm.textAlign as [string, string] | undefined;
  if (textAlign) {
    dto.text_align = textAlign;
  }

  if (typeof ncm.lineMode === "boolean") {
    dto.line_mode = ncm.lineMode ? "single" : "double";
  }
  if (typeof ncm.showHorizontal === "boolean") {
    dto.show_horizontal = ncm.showHorizontal;
  }
  if (typeof ncm.offset === "number") {
    dto.offset_ms = ncm.offset;
  }

  return dto;
}

export async function createDesktopLyricsWindow() {
  const app = getApp();
  lyricsWindow = await LyricsWindow.create(app, { show: false });

  ipcMain.on(
    "desktopLyrics.styleUpdate",
    (_event, style: Record<string, unknown>) => {
      lyricsWindow?.setStyle(convertStyle(style));
    }
  );

  ipcMain.on(
    "desktopLyrics.lyricsUpdate",
    (_event, content: { lrc?: string; tlrc?: string } | null) => {
      if (!content || !content.lrc) {
        lyricsWindow?.setData(null);
        return;
      }
      const data = parseLrc(content.lrc, content.tlrc || undefined);
      lyricsWindow?.setData(data);
    }
  );

  ipcMain.on("desktopLyrics.timeUpdate", (_event, timeMs: number) => {
    lyricsWindow?.setTime(timeMs);
  });
}

export function getDesktopLyricsWindow(): LyricsWindow | null {
  return lyricsWindow;
}
