import { LyricsStore } from "$sharedTypes/lyrics";
import {
  MiniPlayerLikeMark,
  MiniPlayerTogetherStatus,
} from "$sharedTypes/mini-player";
import { registerCallHandler } from "../calls";
import { lyricsDispatcher } from "../lyrics";
import { parseLrc } from "../lyrics/parse";
import {
  updatePlayInfo,
  updateCoverUrl,
  updateLikeMark,
  updatePlayState,
  updateListData,
  showVolume,
  updateFavour,
  updateTogetherStatus,
} from "../windows/mini-player";

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
  const { lrc, tlrc, romalrc } = lyricContent;
  if (!lrc.trim()) {
    lyricsDispatcher.lyrics = null;
    return [true];
  }
  const lyrics: LyricsStore = {
    regular: parseLrc(lrc),
  };
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
