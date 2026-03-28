import { player } from "../audioplayer";
import { registerCallHandler } from "../calls";
import { TextAlignType } from "../Player";

let currentMetadata: MediaMetadata | null = null;

registerCallHandler<
  [
    {
      albumId: string;
      albumName: string;
      artistName: string;
      playId: string;
      songName: string;
      songType: string;
      url: string;
    },
  ],
  void
>("player.setInfo", (playInfo) => {
  if (!playInfo.playId) {
    navigator.mediaSession.metadata = currentMetadata = null;
    player.songInfo = null;
    return;
  }
  player.songInfo = {
    playId: playInfo.playId,
    songName: playInfo.songName,
    artistName: playInfo.artistName,
    albumId: playInfo.albumId,
    albumName: playInfo.albumName,
    songType: playInfo.songType,
    artworkUrl: playInfo.url,
    cover: player.songInfo?.cover ?? "",
    totalTime: player.songInfo?.totalTime ?? 0,
    liked: player.songInfo?.liked ?? false,
  };
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
});

// TODO: Link mediaSession
registerCallHandler<[boolean], void>("player.setSMTCEnable", () => {
  return;
});

registerCallHandler<[string], [boolean]>("player.addListElement", (json) => {
  player.playlist.items.push(...JSON.parse(json));
  return [true];
});

registerCallHandler<[], [boolean]>("player.removeAll", () => {
  player.playlist.items = [];
  return [true];
});

registerCallHandler<[string], [boolean]>("player.setCurrentPlay", (id) => {
  player.playlist.currentPlay = id;
  return [true];
});

registerCallHandler<[string], [boolean]>("player.setCover", (cover) => {
  if (player.songInfo) player.songInfo.cover = cover;
  return [true];
});

registerCallHandler<[number], [boolean]>("player.setLikeMark", (mark) => {
  if (player.songInfo) player.songInfo.liked = mark === 1;
  return [true];
});

registerCallHandler<[number], [boolean]>("player.setTotalTime", (time) => {
  if (player.songInfo) player.songInfo.totalTime = time;
  return [true];
});

registerCallHandler<
  [
    {
      playstate: number; // 0 or 1?
    },
  ],
  [boolean]
>("player.setMiniPlayerState", () => {
  return [true];
});

registerCallHandler<[TextAlignType, TextAlignType], [boolean]>(
  "player.setTextAlign",
  (upperAlign, lowerAlign) => {
    player.lyricStyle.textAlign = [upperAlign, lowerAlign];
    return [true];
  }
);

registerCallHandler<[boolean], [boolean]>("player.setLineMode", (lineMode) => {
  // single line mode
  player.lyricStyle.lineMode = lineMode;
  return [true];
});

registerCallHandler<[boolean], [boolean]>(
  "player.setDesktopLyricTopMost",
  (topMost) => {
    player.lyricStyle.desktopTopMost = topMost;
    return [true];
  }
);

registerCallHandler<[string], [boolean]>(
  "player.showTranslateLyric",
  (mode) => {
    // "translate" ...?
    player.lyricStyle.showTranslate = mode;
    return [true];
  }
);

registerCallHandler<[string, string, string, string], [boolean]>(
  "player.setLRCColor",
  (notPlayedTop, notPlayedBottom, playedTop, playedBottom) => {
    // rrggbb, notplayed top-to-bottom then played top-to-bottom
    player.lyricStyle.lrcColorNotPlayedTop = notPlayedTop;
    player.lyricStyle.lrcColorNotPlayedBottom = notPlayedBottom;
    player.lyricStyle.lrcColorPlayedTop = playedTop;
    player.lyricStyle.lrcColorPlayedBottom = playedBottom;
    return [true];
  }
);

registerCallHandler<[string, string], [boolean]>(
  "player.setOutlineColor",
  (notPlayed, played) => {
    // notplayed, played
    player.lyricStyle.outlineColorNotPlayed = notPlayed;
    player.lyricStyle.outlineColorPlayed = played;
    return [true];
  }
);

registerCallHandler<[boolean, boolean, boolean, boolean], [boolean]>(
  "player.setOutlineShadow",
  (a, b, c, d) => {
    // On: true true false false
    // Off: false false false false
    player.lyricStyle.outlineShadow = [a, b, c, d];
    return [true];
  }
);

registerCallHandler<[boolean], [boolean]>(
  "player.showHorizontalLyric",
  (show) => {
    player.lyricStyle.showHorizontal = show;
    return [true];
  }
);

registerCallHandler<[string, string, string], [boolean]>(
  "player.setLRCFont",
  (fontSize, bold, fontName) => {
    // font size, bold (1 or 0), font name
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

registerCallHandler<[string], [boolean]>("player.setLRCSlogan", (slogan) => {
  player.lyricStyle.slogan = slogan;
  return [true];
});

registerCallHandler<
  [
    {
      krc: string;
      lrc: string;
      romalrc: string;
      tlrc: string;
      yrc: string;
      // No lyric = empty string
    },
  ],
  [boolean]
>("player.setLyrics", (lyrics) => {
  player.lyricContent = {
    krc: lyrics.krc,
    lrc: lyrics.lrc,
    romalrc: lyrics.romalrc,
    tlrc: lyrics.tlrc,
    yrc: lyrics.yrc,
  };
  return [true];
});

registerCallHandler<[number], [boolean]>("player.setOffset", (offset) => {
  player.lyricStyle.offset = offset;
  return [true];
});

registerCallHandler<[string, number], [boolean]>(
  "player.setFont",
  (fontName, fontSize) => {
    // What font is this?
    player.lyricStyle.fontName = fontName;
    player.lyricStyle.fontSize = fontSize;
    return [true];
  }
);

player.addEventListener("load", () => {
  if (!currentMetadata) return;
  // Ensure media session update
  navigator.mediaSession.metadata = currentMetadata;
});
