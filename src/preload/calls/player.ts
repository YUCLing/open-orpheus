import { player } from "../audioplayer";
import { registerCallHandler } from "../calls";

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

player.addEventListener("load", () => {
  if (!currentMetadata) return;
  // Ensure media session update
  navigator.mediaSession.metadata = currentMetadata;
});
