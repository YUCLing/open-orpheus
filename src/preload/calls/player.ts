import { ipcRenderer } from "electron";

import type { ShowTranslate } from "$sharedTypes/desktop-lyrics";

import { player } from "../audioplayer";
import type { TextAlignType } from "../Player";
import { registerCallHandler } from "../calls";
import { transformLyricStyle } from "../desktopLyrics";
import { fireNativeCall } from "../channel";
import type { PlayInfo } from "../../main/calls/player";

let currentMetadata: MediaMetadata | null = null;

registerCallHandler<[PlayInfo], void>("player.setInfo", (playInfo) => {
  if (!playInfo.playId) {
    navigator.mediaSession.metadata = currentMetadata = null;
    return;
  }
  navigator.mediaSession.metadata = currentMetadata = new MediaMetadata({
    title: playInfo.songName,
    artist: playInfo.artistName,
    album: playInfo.albumName,
    artwork: [96, 128, 192, 256, 384, 512].map((size) => ({
      src: playInfo.url + `?param=${size}y${size}`,
      sizes: `${size}x${size}`,
      type: "image/jpeg",
    })),
  });
  // Forward to main process
  ipcRenderer.invoke("channel.call", "player.setInfo", playInfo);
});

// TODO: Link mediaSession
registerCallHandler<[boolean], void>("player.setSMTCEnable", () => {
  return;
});

registerCallHandler<[number], [boolean]>("player.setTotalTime", () => {
  return [true];
});

registerCallHandler<[string, string], [boolean]>(
  "player.setTextAlign",
  (upper, lower) => {
    player.lyricStyle.textAlign = [
      upper as TextAlignType,
      lower as TextAlignType,
    ];
    return [true];
  }
);

registerCallHandler<[boolean], [boolean]>(
  "player.setLineMode",
  (singleLine) => {
    player.lyricStyle.lineMode = singleLine;
    return [true];
  }
);

registerCallHandler<[boolean], [boolean]>(
  "player.setDesktopLyricTopMost",
  (topMost) => {
    player.lyricStyle.desktopTopMost = topMost;
    return [true];
  }
);

registerCallHandler<[ShowTranslate], [boolean]>(
  "player.showTranslateLyric",
  (mode) => {
    player.lyricStyle.showTranslate = mode;
    return [true];
  }
);

registerCallHandler<[string, string, string, string], [boolean]>(
  "player.setLRCColor",
  (notPlayedTop, playedTop, notPlayedBottom, playedBottom) => {
    player.lyricStyle.lrcColorNotPlayedTop = notPlayedTop;
    player.lyricStyle.lrcColorPlayedTop = playedTop;
    player.lyricStyle.lrcColorNotPlayedBottom = notPlayedBottom;
    player.lyricStyle.lrcColorPlayedBottom = playedBottom;
    return [true];
  }
);

registerCallHandler<[string, string], [boolean]>(
  "player.setOutlineColor",
  (notPlayed, played) => {
    player.lyricStyle.outlineColorNotPlayed = notPlayed;
    player.lyricStyle.outlineColorPlayed = played;
    return [true];
  }
);

registerCallHandler<[boolean, boolean, boolean, boolean], [boolean]>(
  "player.setOutlineShadow",
  (a, b, c, d) => {
    player.lyricStyle.outlineShadow = [a, b, c, d];
    return [true];
  }
);

registerCallHandler<[boolean], [boolean]>(
  "player.showHorizontalLyric",
  (horizontal) => {
    player.lyricStyle.showHorizontal = horizontal;
    return [true];
  }
);

registerCallHandler<[string, string, string], [boolean]>(
  "player.setLRCFont",
  (fontSize, bold, fontName) => {
    player.lyricStyle.lrcFontSize = fontSize;
    player.lyricStyle.lrcFontBold = bold === "1";
    player.lyricStyle.lrcFontName = fontName;
    return [true];
  }
);

registerCallHandler<[boolean], [boolean]>("player.setLock", (locked) => {
  player.lyricStyle.locked = locked;
  return [true];
});

registerCallHandler<[number], [boolean]>("player.setOffset", (offset) => {
  player.lyricStyle.offset = offset;
  return [true];
});

registerCallHandler<[string, string], [boolean]>(
  "player.renderLRCImage",
  async (text, path) => {
    const [width, height] = await ipcRenderer.invoke(
      "desktopLyrics.renderPreview",
      transformLyricStyle(player.lyricStyle),
      text,
      path
    );
    fireNativeCall("player.onRenderLRCImageResult", path, true, width, height);
    return [true];
  }
);

registerCallHandler<[string, number], [boolean]>("player.setFont", () => {
  // What font is this?
  return [true];
});

player.addEventListener("load", () => {
  if (!currentMetadata) return;
  // Ensure media session update
  navigator.mediaSession.metadata = currentMetadata;
});
