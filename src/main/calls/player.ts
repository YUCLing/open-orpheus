import {
  LineMode,
  ShowTranslate,
  TextAlignType,
} from "$sharedTypes/desktop-lyrics";
import { LyricsStore } from "$sharedTypes/lyrics";
import {
  MiniPlayerLikeMark,
  MiniPlayerTogetherStatus,
} from "$sharedTypes/mini-player";
import { mkdir, writeFile } from "node:fs/promises";
import { registerCallHandler } from "../calls";
import { storage as storageDir } from "../folders";
import { lyricsDispatcher } from "../lyrics";
import { parseLrc, parseYrc } from "../lyrics/parse";
import { sanitizeRelativePath } from "../util";
import {
  createDesktopLyricsPreview,
  desktopLyricsWindow,
  lyricsStyle,
  refreshLyricsStyle,
  setLyricsLocked,
  setLyricsOffset,
} from "../windows/desktop-lyrics";
import {
  updatePlayInfo,
  updateCoverUrl,
  updateLikeMark,
  updatePlayState,
  updateListData,
  showVolume,
  updateFavour,
  updateTogetherStatus,
  updateMute,
} from "../windows/mini-player";
import { dirname } from "node:path";
import { setFont } from "../gui";

let listItems: ListElement[] = [];
let currentPlay: string | null = null;

export type PlayInfo = {
  albumId: string;
  albumName: string;
  artistName: string;
  playId: string;
  songName: string;
  songType: string;
  url: string;
};

registerCallHandler<[PlayInfo], void>("player.setInfo", (_event, playInfo) => {
  updatePlayInfo(playInfo);
});

type ListElement = {
  id: string;
  from: string;
  title: string;
  track_id: string;
  program: null;
  mv: string;
  album: string;
  artist: string;
  alias: string;
  cloud: 0 | 1;
};
registerCallHandler<[string], [boolean]>(
  "player.addListElement",
  (_event, json) => {
    const listElements = JSON.parse(json) as ListElement[];
    listItems = listItems.concat(listElements);
    updateListData(listItems, currentPlay);
    return [true];
  }
);

registerCallHandler<[string], [boolean]>(
  "player.deleteListElement",
  (_event, json) => {
    const removals = JSON.parse(json) as string[];
    listItems = listItems.filter((v) => !removals.includes(v.id));
    updateListData(listItems, currentPlay);
    return [true];
  }
);

registerCallHandler<[], [boolean]>("player.removeAll", () => {
  listItems = [];
  currentPlay = null;
  updateListData([], null);
  return [true];
});

registerCallHandler<[string], [boolean]>(
  "player.setCurrentPlay",
  (_event, id) => {
    currentPlay = id;
    updateListData(listItems, currentPlay);
    return [true];
  }
);

registerCallHandler<[string], [boolean]>("player.setCover", (_event, url) => {
  updateCoverUrl(url);
  return [true];
});

registerCallHandler<[MiniPlayerLikeMark], [boolean]>(
  "player.setLikeMark",
  (_event, likeMark) => {
    updateLikeMark(likeMark);
    return [true];
  }
);

registerCallHandler<[0 | 1], [boolean]>(
  "player.setFavour",
  (_event, favour) => {
    updateFavour(favour > 0);
    return [true];
  }
);

registerCallHandler<[boolean], [boolean]>("player.mute", (event, mute) => {
  updateMute(mute);
  return [true];
});

registerCallHandler<
  [
    {
      playstate: 0 | 1;
    },
  ],
  [boolean]
>("player.setMiniPlayerState", (_event, state) => {
  updatePlayState(state.playstate !== 1);
  return [true];
});

registerCallHandler<[MiniPlayerTogetherStatus], [boolean]>(
  "player.setMiniTogetherStatus",
  (event, status) => {
    updateTogetherStatus(status);
    return [true];
  }
);

registerCallHandler<[number, boolean], [boolean]>(
  "player.showVolume",
  (event, volume, muted) => {
    showVolume(volume, muted);
    return [true];
  }
);

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
>("player.setLyrics", (event, lyricContent) => {
  const { lrc, yrc, tlrc, romalrc } = lyricContent;
  if (!lrc.trim()) {
    lyricsDispatcher.lyrics = null;
    return [true];
  }
  const lyrics: LyricsStore = {
    regular: parseLrc(lrc),
  };
  if (yrc.trim()) {
    lyrics["per-word"] = parseYrc(yrc);
  }
  if (tlrc.trim()) {
    lyrics.translate = parseLrc(tlrc);
  }
  if (romalrc.trim()) {
    lyrics.roma = parseLrc(romalrc);
  }
  lyricsDispatcher.lyrics = lyrics;
  return [true];
});

registerCallHandler<[string], [boolean]>(
  "player.setLRCSlogan",
  (event, slogan) => {
    lyricsDispatcher.slogan = slogan;
    return [true];
  }
);

registerCallHandler<[string, string], [boolean]>(
  "player.setTextAlign",
  (evnet, upper, lower) => {
    lyricsStyle.textAlign = [upper as TextAlignType, lower as TextAlignType];
    return [refreshLyricsStyle()];
  }
);

registerCallHandler<[boolean], [boolean]>(
  "player.setLineMode",
  (event, singleLine) => {
    lyricsStyle.lineMode = singleLine ? LineMode.Single : LineMode.Double;
    return [refreshLyricsStyle()];
  }
);

registerCallHandler<[boolean], [boolean]>(
  "player.setDesktopLyricTopMost",
  (event, topMost) => {
    if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed())
      return [false];
    desktopLyricsWindow.setAlwaysOnTop(topMost);
    return [true];
  }
);

registerCallHandler<[ShowTranslate], [boolean]>(
  "player.showTranslateLyric",
  (event, mode) => {
    lyricsStyle.showTranslate = mode as ShowTranslate;
    return [refreshLyricsStyle()];
  }
);

registerCallHandler<[string, string, string, string], [boolean]>(
  "player.setLRCColor",
  (event, notPlayedTop, playedTop, notPlayedBottom, playedBottom) => {
    lyricsStyle.color = {
      notPlayed: {
        top: `#${notPlayedTop}`,
        bottom: `#${notPlayedBottom}`,
      },
      played: {
        top: `#${playedTop}`,
        bottom: `#${playedBottom}`,
      },
    };
    return [refreshLyricsStyle()];
  }
);

registerCallHandler<[string, string], [boolean]>(
  "player.setOutlineColor",
  (event, notPlayed, played) => {
    lyricsStyle.outline = {
      notPlayed: `#${notPlayed}`,
      played: `#${played}`,
    };
    return [refreshLyricsStyle()];
  }
);

registerCallHandler<[boolean, boolean, boolean, boolean], [boolean]>(
  "player.setOutlineShadow",
  (event, a, b) => {
    lyricsStyle.dropShadow = a || b;
    return [refreshLyricsStyle()];
  }
);

registerCallHandler<[boolean], [boolean]>(
  "player.showHorizontalLyric",
  (event, horizontal) => {
    lyricsStyle.vertical = !horizontal;
    return [refreshLyricsStyle()];
  }
);

registerCallHandler<[string, number], [boolean]>(
  "player.setFont",
  (event, font) => {
    setFont(font);
    return [true];
  }
);

registerCallHandler<[string, string, string], [boolean]>(
  "player.setLRCFont",
  (evnet, fontSize, bold, fontName) => {
    lyricsStyle.font = {
      size: Number(fontSize),
      weight: bold === "1" ? "bold" : "normal",
      family: fontName,
    };
    return [refreshLyricsStyle()];
  }
);

registerCallHandler<[boolean], [boolean]>("player.setLock", (event, locked) => {
  return [setLyricsLocked(locked)];
});

registerCallHandler<[number], [boolean]>(
  "player.setOffset",
  (event, offset) => {
    return [setLyricsOffset(offset)];
  }
);

registerCallHandler<[string, string], [boolean]>(
  "player.renderLRCImage",
  async (event, text, path) => {
    // This call must be returned AFTER result is called.
    const filePath = sanitizeRelativePath(storageDir, path);
    if (filePath === false) {
      console.warn(
        "Attempted to save desktop lyrics preview to invalid path:",
        path
      );
      return [false];
    }
    const [buf, [width, height]] = await createDesktopLyricsPreview(
      lyricsStyle,
      text
    );
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, buf);
    event.sender.send(
      "channel.call",
      "player.onRenderLRCImageResult",
      path,
      true,
      width,
      height
    );
    return [true];
  }
);
