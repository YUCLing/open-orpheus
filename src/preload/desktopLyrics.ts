import { ipcRenderer } from "electron";
import { player } from "./audioplayer";
import type { LyricStyle } from "./Player";

export function transformLyricStyle(s: LyricStyle) {
  return {
    textAlign: s.textAlign,
    lineMode: s.lineMode,
    colorNotPlayedTop: s.lrcColorNotPlayedTop
      ? `#${s.lrcColorNotPlayedTop}`
      : undefined,
    colorNotPlayedBottom: s.lrcColorNotPlayedBottom
      ? `#${s.lrcColorNotPlayedBottom}`
      : undefined,
    colorPlayedTop: s.lrcColorPlayedTop ? `#${s.lrcColorPlayedTop}` : undefined,
    colorPlayedBottom: s.lrcColorPlayedBottom
      ? `#${s.lrcColorPlayedBottom}`
      : undefined,
    outlineColorNotPlayed: s.outlineColorNotPlayed
      ? `#${s.outlineColorNotPlayed}`
      : undefined,
    outlineColorPlayed: s.outlineColorPlayed
      ? `#${s.outlineColorPlayed}`
      : undefined,
    dropShadow:
      s.outlineShadow[0] || s.outlineShadow[1]
        ? "0 2px 4px rgba(0,0,0,0.5)"
        : "",
    vertical: !s.showHorizontal,
    fontSize: parseInt(s.lrcFontSize, 10) || s.fontSize || 36,
    fontWeight: s.lrcFontBold ? "bold" : "normal",
    fontFamily: s.lrcFontName || s.fontName || "sans-serif",
    offset: s.offset,
    showTranslate: s.showTranslate,
  };
}

// Forward style updates
const styleKeyMap: Partial<Record<keyof LyricStyle, (value: never) => void>> = {
  textAlign: (v) =>
    ipcRenderer.invoke("desktopLyrics.updateStyle", { textAlign: v }),
  lineMode: (v) =>
    ipcRenderer.invoke("desktopLyrics.updateStyle", { lineMode: v }),
  lrcColorNotPlayedTop: (v: string) =>
    ipcRenderer.invoke("desktopLyrics.updateStyle", {
      colorNotPlayedTop: v ? `#${v}` : undefined,
    }),
  lrcColorNotPlayedBottom: (v: string) =>
    ipcRenderer.invoke("desktopLyrics.updateStyle", {
      colorNotPlayedBottom: v ? `#${v}` : undefined,
    }),
  lrcColorPlayedTop: (v: string) =>
    ipcRenderer.invoke("desktopLyrics.updateStyle", {
      colorPlayedTop: v ? `#${v}` : undefined,
    }),
  lrcColorPlayedBottom: (v: string) =>
    ipcRenderer.invoke("desktopLyrics.updateStyle", {
      colorPlayedBottom: v ? `#${v}` : undefined,
    }),
  outlineColorNotPlayed: (v: string) =>
    ipcRenderer.invoke("desktopLyrics.updateStyle", {
      outlineColorNotPlayed: v ? `#${v}` : undefined,
    }),
  outlineColorPlayed: (v: string) =>
    ipcRenderer.invoke("desktopLyrics.updateStyle", {
      outlineColorPlayed: v ? `#${v}` : undefined,
    }),
  outlineShadow: (v: [boolean, boolean, boolean, boolean]) =>
    ipcRenderer.invoke("desktopLyrics.updateStyle", {
      dropShadow: v[0] || v[1] ? "0 2px 4px rgba(0,0,0,0.5)" : "",
    }),
  lrcFontSize: (v: string) =>
    ipcRenderer.invoke("desktopLyrics.updateStyle", {
      fontSize: parseInt(v, 10) || 36,
    }),
  lrcFontBold: (v: boolean) =>
    ipcRenderer.invoke("desktopLyrics.updateStyle", {
      fontWeight: v ? "bold" : "normal",
    }),
  lrcFontName: (v: string) =>
    ipcRenderer.invoke("desktopLyrics.updateStyle", {
      fontFamily: v || "sans-serif",
    }),
  showHorizontal: (v: boolean) =>
    ipcRenderer.invoke("desktopLyrics.updateStyle", { vertical: !v }),
  showTranslate: (v) =>
    ipcRenderer.invoke("desktopLyrics.updateStyle", { showTranslate: v }),
  offset: (v) => ipcRenderer.invoke("desktopLyrics.updateStyle", { offset: v }),
  desktopTopMost: (v) => ipcRenderer.invoke("desktopLyrics.setTopMost", v),
  locked: (v) => ipcRenderer.invoke("desktopLyrics.setLocked", v),
};

player.addEventListener("lyricstyleupdate", (e) => {
  const { key, value } = (e as CustomEvent).detail;
  const handler = styleKeyMap[key as keyof LyricStyle];
  if (handler) handler(value as never);
});

// Handle full state request from desktop lyrics window
ipcRenderer.on("desktopLyrics.sendFullState", () => {
  // Re-send style from player.lyricStyle
  ipcRenderer.invoke(
    "desktopLyrics.updateStyle",
    transformLyricStyle(player.lyricStyle)
  );

  // Re-send locked state
  ipcRenderer.invoke("desktopLyrics.setLocked", player.lyricStyle.locked);
});
