import { registerCallHandler } from "../calls";
import { fireNativeCall } from "../channel";

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
    ["nexttrack", "previoustrack", "stop"].forEach((action) => {
      navigator.mediaSession.setActionHandler(action as MediaSessionAction, null);
    });
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
  navigator.mediaSession.setActionHandler("nexttrack", () => {
    fireNativeCall("winhelper.onHotkey", "next_1", true);
  });
  navigator.mediaSession.setActionHandler("previoustrack", () => {
    fireNativeCall("winhelper.onHotkey", "prev_1", true);
  });
  navigator.mediaSession.setActionHandler("stop", () => {
    fireNativeCall("winhelper.onHotkey", "stop", true);
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
  "setTotalTime",
  "setLyrics",
  "setOffset",
].forEach((cmd) => {
  registerCallHandler<[], [boolean]>(`player.${cmd}`, () => {
    console.warn(
      `player.${cmd} is not implemented yet, but returning true now.`
    );
    return [true];
  });
});
