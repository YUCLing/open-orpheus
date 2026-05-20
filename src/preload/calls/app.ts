import { ipcRenderer } from "electron";
import { SECRET_KEY } from "../../constants";
import { player } from "../audioplayer";
import { registerCallHandler } from "../calls";
import { fireNativeCall } from "../channel";
import {
  recCtx,
  startContinuousRecord,
  stopContinuousRecord,
} from "../recorder";

// These are not needed?
registerCallHandler<[], void>("app.statis", () => {
  /* empty */
});
registerCallHandler<[], void>("app.statisV2", () => {
  /* empty */
});
registerCallHandler<[], void>("app.sendStatis", () => {
  /* empty */
});

// Need more info on these
registerCallHandler<[], string[]>("app.getABTestKeys", () => [
  //"PH-PC-DAWNLOG-NEW",
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
registerCallHandler<[Record<string, object>], void>(
  "app.abtestSwitchV2",
  () => {
    /* empty */
  }
);

const cooperation = {
  main: "",
  sub: "",
};
registerCallHandler<[], [typeof cooperation]>("app.getCooperation", () => [
  cooperation,
]);

registerCallHandler<[], [string]>("app.getAppStartTime", () => {
  // TODO: Implement this properly
  return ["542493"]; // What is this?
});

registerCallHandler<[], [string]>("app.getAppStartType", () => {
  return [""];
});

registerCallHandler<[], [boolean]>("app.initUrls", () => {
  // TODO: Implement this properly? What does this even do?
  return [true];
});

registerCallHandler<[string], [string]>("app.getP2PUrl", (url) => {
  // We don't support P2P
  return [url];
});

registerCallHandler<[string, string, object], void>(
  "app.getNativeData",
  (taskId, key) => {
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
  }
);

registerCallHandler<[{ path: string; pathtype: string }], void>(
  "app.systemVoiceHint",
  async (voice) => {
    if (voice.pathtype !== "resource") {
      console.warn("Unsupported voice hint type", voice.pathtype);
      return;
    }

    const response = await fetch(`audio://resource/${voice.path}`);
    const arrayBuffer = await response.arrayBuffer();

    const audioBuffer = await player.audioContext.decodeAudioData(arrayBuffer);

    const source = player.audioContext.createBufferSource();
    source.buffer = audioBuffer;

    source.connect(player.gainNode);
    source.start();
  }
);

const activeRecognizeTasks = new Set<string>();
registerCallHandler<[string], void>("app.recognizeMusic", async (guid) => {
  activeRecognizeTasks.add(guid);

  const sessionId = crypto.randomUUID().toUpperCase();
  const recordtime = Date.now();

  try {
    await startContinuousRecord(guid);

    for (let times = 1; times <= 5; times++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (!activeRecognizeTasks.has(guid)) break;

      const duration = times * 3;
      const endSample = duration * 8000;

      const chunk = recCtx!.buffer.subarray(
        0,
        Math.min(endSample, recCtx!.getOffset())
      );
      const rawdata = await ipcRenderer.invoke(
        "afp.generateFP",
        chunk.buffer.slice(
          chunk.byteOffset,
          chunk.byteOffset + chunk.byteLength
        )
      );

      const payload = new URLSearchParams({
        algorithmCode: "shazam_v2",
        duration: duration.toString(),
        rawdata,
        sessionId,
        decrypt: "1",
        from: "pc_back_discern",
        times: times.toString(),
      }).toString();

      const [res] = await ipcRenderer.invoke("channel.call", "network.fetch", {
        url: `https://interfacepc.music.163.com/api/music/audio/match?${payload}`,
        method: "GET",
        body: "",
        retryCount: 1,
      });

      const responsetime = Date.now();
      let code = res.status === 200 ? 0 : res.status;
      const httpmsg = res.blob || "{}";
      let hasMatch = false;

      try {
        const body = JSON.parse(httpmsg);
        if (body.code === 200 && body.data?.result !== null) {
          hasMatch = true;
        }
      } catch (e) {
        console.error(e);
        code = -101;
      }

      if (hasMatch || times === 5) {
        fireNativeCall("app.onRecognizeMusic", {
          code,
          duration,
          guid,
          httpmsg,
          recordtime,
          responsetime,
          sessionId,
          times,
        });

        break;
      }
    }
  } catch (err) {
    console.error(err);
    fireNativeCall("app.onRecognizeMusic", {
      code: -100,
      duration: 0,
      guid,
      httpmsg: {},
      recordtime,
      responsetime: Date.now(),
      sessionId,
      times: 0,
    });
  } finally {
    stopContinuousRecord(guid);
    activeRecognizeTasks.delete(guid);
  }
});

registerCallHandler<[string], void>("app.stopRecognizeMusic", (guid) => {
  activeRecognizeTasks.delete(guid);
  stopContinuousRecord(guid);
});

registerCallHandler<[string], void>("app.clearRecognizeMusicCache", (guid) => {
  activeRecognizeTasks.delete(guid);
  stopContinuousRecord(guid);
});
