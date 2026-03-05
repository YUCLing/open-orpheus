import { player } from "../audioplayer";
import { registerCallHandler } from "../calls";
import { AudioPlayInfo } from "../Player";

registerCallHandler<[string, AudioPlayInfo], void>(
  "audioplayer.load",
  async (id, playInfo) => {
    await player.load(playInfo);
  }
);

registerCallHandler<[AudioPlayInfo], void>(
  "audioplayer.setRefreshSongUrlResult",
  async (result) => {
    if (player.currentPlayInfo?.playId !== result.playId) return;
    await player.load(result);
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

registerCallHandler<[number], void>("audioplayer.setPlaybackRate", (rate) => {
  player.audio.playbackRate = rate;
});

// TODO: What's this?
registerCallHandler<object[], void>("audioplayer.setAudioStrategy", () => {
  console.warn("audioplayer.setAudioStrategy is not implemented yet.");
});

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

const failedPlaybackInfo = {
  cacheStrategyCode: "",
  cdnUsed: false,
  deviceAudioFormat: {
    channels: 0,
    samplerate: 0,
    samplesize: 0,
  },
  hasNetworkJanks: false,
  hasSeekJanks: false,
  hasSystemJanks: false,
  p2pUsed: false,
  playAudioFormat: {
    channels: 0,
    samplerate: 0,
    samplesize: 0,
  },
  playId: "",
  playedPercent: 0,
  playedTime: 0,
  preloadWholeCached: false,
  result: false,
  souceType: 0,
  sourceAudioFormat: {
    channels: 0,
    samplerate: 0,
    samplesize: 0,
  },
  strategyCode: "",
  wholeCached: true,
};
// Never had successful playback, so just return failed info for now
registerCallHandler<[{ playId: string }], [typeof failedPlaybackInfo]>(
  "audioplayer.getPlaybackInfo",
  () => [failedPlaybackInfo]
);

registerCallHandler<
  [{ device: string; use_play_device: boolean }],
  [{ result: boolean }]
>("audioplayer.immerseSurroundSupport", () => {
  return [{ result: false }];
});

registerCallHandler<
  [{ device: string; use_play_device: boolean; enable: boolean }],
  void
>("audioplayer.immerseSurroundSupportWatch", () => {
  return;
});

// TODO: Audio player effect support
registerCallHandler<[string, [{ name: string; on: boolean }]], void>(
  "audioplayer.switchEffect",
  () => {
    return;
  }
);
