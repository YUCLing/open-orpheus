import { player } from "../audioplayer";
import { registerCallHandler } from "../calls";

registerCallHandler<[string, { musicurl: string }], void>(
  "audioplayer.load",
  async (id, playInfo) => {
    await player.load(id, playInfo.musicurl);
  }
);

registerCallHandler<[string], void>("audioplayer.play", async (id) => {
  if (player.currentId !== id) return;
  await player.audio.play();
});

registerCallHandler<[string, string], void>("audioplayer.pause", (id) => {
  if (player.currentId !== id) return;
  player.audio.pause();
});

registerCallHandler<[string, string, number], void>(
  "audioplayer.seek",
  (id, opId, time) => {
    if (player.currentId !== id) return;
    player.audio.currentTime = time;
  }
);

registerCallHandler<[string, string, number], void>(
  "audioplayer.setVolume",
  (a, b, volume) => {
    player.audio.volume = volume;
  }
);

// TODO: Implement this properly
registerCallHandler<
  [{ playId: string }],
  [
    {
      playedAudioTime: number;
      playedTime: number;
      result: boolean;
    },
  ]
>("audioplayer.getPlayedTime", () => {
  return [
    {
      playedAudioTime: player.audio.currentTime,
      playedTime: player.audio.currentTime,
      result: true,
    },
  ];
});
