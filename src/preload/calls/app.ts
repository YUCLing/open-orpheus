import { SECRET_KEY } from "../../constants";
import { registerCallHandler } from "../calls";
import { fireNativeCall } from "../channel";
import MusicRecognizer from "../MusicRecognizer";
import { channel } from "../util";

// These are not needed?
registerCallHandler<[], void>("app.statis", () => {
  /* empty */
});
registerCallHandler<[], void>("app.sendStatis", () => {
  /* empty */
});

// Need more info on these
registerCallHandler<[], string[]>("app.getABTestKeys", () => [
  "PH-PC-DAWNLOG-NEW",
  //"PC-blur-enable",
  //"PH-PC-P2P-Enable",
  //"PC-GPU-enable",
  //"PC-httpdns-resource-enable",
  //"PC-httpdns-enable",
  //"PC-httpdns-api-enable",
  //"PC-cronet-enable-ver",
  //"PH-PC-SYSTEM_LOCK_RECOVER_NEW",
  //"PH-PC-Xunlei-SDK-Strategy",
  //"PH-PC-API-HORSERACE",
  //"PH-PC-HIDE_ZERO_SIZE",
  //"PH-PC-REQUEST_RANGE_ALIGN",
  //"PH-PC-newNetLibV2",
  "PH-PC-newAPMLIBV2", // 新主页和播放器样式
  //"PH-PC-TASKBAR_ICON_WINDOW",
  //"PH-PC-IPV6Enable",
  //"PH-PC-PERF_MONITOR_ENABLE",
  //"PH-PC-SAFEMODE-CLEAN-V3",
  //"PH-PC-BOOTMONITOR",
  //"PH-PC-AsyncDNS",
  //"PH-PC-HTTPDNS_IPRACE",
]);
registerCallHandler<[Record<string, boolean>], void>("app.abtestSwitch", () => {
  /* empty */
});
registerCallHandler<[Record<string, object>], void>("app.abtestSwitchV2", () => {
  /* empty */
});

const cooperation = {
  main: "",
  sub: "",
};
registerCallHandler<[], [typeof cooperation]>("app.getCooperation", () => [cooperation]);

registerCallHandler<[], [string]>("app.getAppStartTime", () => {
  // TODO: Implement this properly
  return ["542493"]; // What is this?
});

registerCallHandler<[string], [string]>("app.getP2PUrl", (url) => {
  // We don't support P2P
  return [url];
});

registerCallHandler<[string, string, object], void>("app.getNativeData", (taskId, key) => {
  switch (key) {
    case "secretKey":
      // Frontend only register the call AFTER this call,
      // so setImmediate to ensure the callback is registered
      setImmediate(() => {
        fireNativeCall("app.onGetNativeData", taskId, key, {
          secretKey: SECRET_KEY,
        });
      });
      break;
  }
});

if (channel === "main") {
  // Only main window will have audio system available
  registerCallHandler<[{ path: string; pathtype: string }], void>(
    "app.systemVoiceHint",
    async (voice) => {
      if (voice.pathtype !== "resource") {
        LOGGER.warn({ pathtype: voice.pathtype }, "Unsupported voice hint type");
        return;
      }

      const [player, arrayBuffer] = await Promise.all([
        import("../audioplayer").then((m) => m.player),
        fetch(`audio://resource/${voice.path}`).then((v) => v.arrayBuffer()),
      ]);

      const audioBuffer = await player.audioContext.decodeAudioData(arrayBuffer);

      const source = player.audioContext.createBufferSource();
      source.buffer = audioBuffer;

      source.connect(player.gainNode);
      source.start();

      LOGGER.info({ path: voice.path, duration: audioBuffer.duration }, "System voice hint played");
    }
  );
}

const recognizeTasks = new Map<string, MusicRecognizer>();

registerCallHandler<[string], void>("app.recognizeMusic", async (guid) => {
  recognizeTasks.get(guid)?.stop();

  const recognizer = new MusicRecognizer();
  recognizeTasks.set(guid, recognizer);
  LOGGER.debug({ guid }, "Music recognition started");

  try {
    const result = await recognizer.start();
    if (result) {
      fireNativeCall("app.onRecognizeMusic", {
        ...result,
        guid,
      });
      LOGGER.info(
        { guid, code: result.code, duration: result.duration },
        "Music recognition finished"
      );
    }
  } finally {
    if (recognizeTasks.get(guid) === recognizer) {
      recognizeTasks.delete(guid);
    }
  }
});

function stopRecognizeTask(guid: string) {
  const recognizer = recognizeTasks.get(guid);
  if (!recognizer) return;
  recognizer.stop();
  recognizeTasks.delete(guid);
}

registerCallHandler<[string], void>("app.stopRecognizeMusic", (guid) => {
  stopRecognizeTask(guid);
});

registerCallHandler<[string], void>("app.clearRecognizeMusicCache", (guid) => {
  stopRecognizeTask(guid);
});
