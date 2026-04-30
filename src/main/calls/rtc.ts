import { BrowserWindow, dialog } from "electron";
import { registerCallbackHandler, registerCallHandler } from "../calls";
import { enterOrJoinRtc, leaveListenTogether } from "../nim";

registerCallbackHandler<
  [
    {
      type: string;
      appinfo: string;
      desc: string;
      subDesc: string;
      avatarUrl: string;
      yes: string;
      no: string;
      userdata: string;
    },
  ]
>("app.systemUIHint", (callback, event, params) => {
  // Only handle "question" type; other types are not supported yet
  if (params.type !== "question") {
    callback(false);
    return;
  }

  const wnd = BrowserWindow.fromWebContents(event.sender);
  if (!wnd) {
    callback(false);
    return;
  }

  wnd.focus();
  wnd.show();

  const timeout = setTimeout(() => {
    callback({ action: "no", userdata: params.userdata });
  }, 30000);

  dialog
    .showMessageBox(wnd, {
      type: "question",
      title: params.appinfo,
      message: params.desc,
      detail: params.subDesc,
      buttons: [params.yes, params.no],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    .then((result) => {
      clearTimeout(timeout);
      callback({
        action: result.response === 0 ? "yes" : "no",
        userdata: params.userdata,
      });
    })
    .catch(() => {
      clearTimeout(timeout);
      callback({ action: "no", userdata: params.userdata });
    });
});

registerCallHandler<[], [boolean]>("rtc.leave", () => {
  leaveListenTogether("rtc.leave");
  return [true];
});

registerCallHandler<[Record<string, unknown>], [boolean]>(
  "rtc.enter",
  (event, params) => {
    enterOrJoinRtc("enter", event.sender, params);
    return [true];
  },
);

registerCallHandler<[Record<string, unknown>], [boolean]>(
  "rtc.join",
  (event, params) => {
    enterOrJoinRtc("join", event.sender, params);
    return [true];
  },
);

registerCallHandler<[], [boolean]>("rtc.mute", () => {
  return [true];
});

registerCallHandler<[], [boolean]>("rtc.unmute", () => {
  return [true];
});

registerCallHandler<[boolean], [boolean]>("rtc.enableAudio", () => {
  return [true];
});

registerCallHandler<[Record<string, unknown>], [boolean]>(
  "rtc.setAudioProfile",
  () => {
    return [true];
  },
);
