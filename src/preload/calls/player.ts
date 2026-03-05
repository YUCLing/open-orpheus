import { registerCallHandler } from "../calls";

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
    navigator.mediaSession.metadata = null;
    return;
  }
  navigator.mediaSession.metadata = new MediaMetadata({
    title: playInfo.songName,
    artist: playInfo.artistName,
    album: playInfo.albumName,
    artwork: [
      {
        src: playInfo.url + "?param=512y512",
        sizes: "512x512",
        type: "image/jpeg",
      },
    ],
  });
});

// TODO: Link mediaSession
registerCallHandler<[boolean], void>("player.setSMTCEnable", () => {
  return;
});

registerCallHandler<[], void>("player.removeAll", () => {
  navigator.mediaSession.metadata = null;
});

// Dummy setup handlers that returns true
[
  "setTextAlign",
  "setLineMode",
  "setCurrentPlay",
  "setDesktopLyricTopMost",
  "showTranslateLyric",
  "setLRCColor",
  "setOutlineColor",
  "setOutlineShadow",
  "showHorizontalLyric",
  "setLRCFont",
  "setLock",
  "setFont",
  "setLRCSlogan",
  "setMiniPlayerState",
  "setCover",
  "setLikeMark",
  "addListElement",
].forEach((cmd) => {
  registerCallHandler<[], [boolean]>(`player.${cmd}`, () => {
    console.warn(
      `player.${cmd} is not implemented yet, but returning true now.`
    );
    return [true];
  });
});
