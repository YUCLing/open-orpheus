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

registerCallHandler<[], void>("player.removeAll", () => {
  navigator.mediaSession.metadata = null;
});
