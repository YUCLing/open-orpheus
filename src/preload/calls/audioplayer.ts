import { ipcRenderer } from "electron";
import { player } from "../audioplayer";
import { registerCallHandler } from "../calls";
import { fireNativeCall } from "../channel";
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
  await player.play();
});

registerCallHandler<[string, string], void>("audioplayer.pause", (id) => {
  if (player.currentId !== id) return;
  player.pause();
});

registerCallHandler<[string], void>("audioplayer.stop", (id) => {
  if (player.currentId !== id) return;
  player.stop();
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
    player.volume = volume;
  }
);

registerCallHandler<[number], void>("audioplayer.setPlaybackRate", (rate) => {
  player.playbackRate = rate;
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

registerCallHandler<[number], void>(
  "audioplayer.enableAudioData",
  async (enable) => {
    try {
      await player.setAudioDataEnabled(enable === 1);
    } catch (err) {
      console.error("Failed to change audio data capture state:", err);
    }
  }
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

type AudioDeviceInit = {
  deviceId: string;
  id: number;
  name: string;
};
type AudioDeviceInfo = AudioDeviceInit & {
  type: string;
};

registerCallHandler<[string, { device: AudioDeviceInit; type: string }], void>(
  "audioplayer.init",
  async (kind, { device }) => {
    if (kind === "device") {
      await Promise.allSettled([
        ipcRenderer.invoke("audio.setDevice", device.deviceId),
        (player.audioContext as unknown as HTMLAudioElement).setSinkId(
          device.deviceId
        ),
      ]);
    }
  }
);

function mediaDeviceInfoToDevice(device: MediaDeviceInfo): AudioDeviceInfo {
  return {
    deviceId: device.deviceId,
    id: -1,
    name: device.label,
    type: "Chromium",
  };
}
registerCallHandler<[string], void>(
  "audioplayer.enmeratorDevices",
  (deviceType) => {
    navigator.mediaDevices.enumerateDevices().then((devices) => {
      const filteredDevices = devices.filter((device) => {
        if (deviceType === "getOutDevices") {
          return device.kind === "audiooutput";
        }
        return false;
      });
      let defaultDeviceInfo: MediaDeviceInfo | null = null;
      let currentAudioOutputDeviceInfo: MediaDeviceInfo | null = null;
      fireNativeCall(
        "audioplayer.onEnmeratorDevices",
        deviceType,
        [
          {
            devices: filteredDevices.map((device) => {
              if (
                device.deviceId ===
                (player.audioContext as unknown as HTMLAudioElement).sinkId
              ) {
                currentAudioOutputDeviceInfo = device;
              } else if (device.deviceId === "default") {
                defaultDeviceInfo = device;
              }
              return mediaDeviceInfoToDevice(device);
            }),
            type: "Chromium",
          },
        ],
        currentAudioOutputDeviceInfo
          ? mediaDeviceInfoToDevice(currentAudioOutputDeviceInfo)
          : defaultDeviceInfo
            ? mediaDeviceInfoToDevice(defaultDeviceInfo)
            : { deviceId: "default", id: -1, name: "Default", type: "Wasapi" }
      );
    });
  }
);

const systemMasterVolume = {
  muted: false,
  realVolume: 1, // Actual system volume if not muted
  volume: 1,
};
registerCallHandler<[], [typeof systemMasterVolume]>(
  "audioplayer.getSystemMasterVolume",
  () => {
    // TODO: Implement actual system master volume retrieval.
    return [systemMasterVolume];
  }
);
