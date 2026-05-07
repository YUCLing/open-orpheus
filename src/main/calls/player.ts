import { registerCallHandler } from "../calls";
import {
  updatePlayInfo,
  updateCoverUrl,
  updateLikeMark,
  updatePlayState,
  updateListData,
  showVolume,
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
  updateCoverUrl(playInfo.url);
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

registerCallHandler<[0 | 1], [boolean]>(
  "player.setLikeMark",
  (_event, likeMark) => {
    const like = likeMark > 0;
    updateLikeMark(like);
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

registerCallHandler<[number, boolean], [boolean]>(
  "player.showVolume",
  (event, volume, muted) => {
    showVolume(volume, muted);
    return [true];
  }
);
