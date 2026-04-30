import { ipcRenderer } from "electron";
import {
  suppressListenTogetherPlaybackResume,
  suppressListenTogetherRemoteChangeEcho,
} from "../audioplayer";
import { registerCallHandler } from "../calls";
import { fireNativeCall } from "../channel";
import { dispatchChatRoomMsg, imState } from "../yunxin";
import {
  extractListenTogetherCommandInfo,
  getCommandSongId,
  normalizeCommandToken,
} from "../../shared/listenTogetherCommand";
import { IPC } from "../../shared/listenTogetherConstants";

type ImEnterParams = {
  chat_roomid: string;
  userId?: string | number;
  user_id?: string | number;
  account?: string | number;
  [key: string]: unknown;
};

type ImSendParams = {
  text: string;
  to: string;
};

type NimChatRoomMsg = Record<string, unknown> & {
  msg?: unknown;
  text?: unknown;
};

const CHAT_ROOM_MESSAGE_TEXT_KEYS = ["msg", "text", "content", "attach", "custom"];

const localState = {
  roomId: null as string | null,
  userId: null as string | null,
  entered: false,
};

function toChatRoomMsgText(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object") return JSON.stringify(value);
  return null;
}

function getChatRoomMsgText(msg: NimChatRoomMsg) {
  for (const key of CHAT_ROOM_MESSAGE_TEXT_KEYS) {
    const text = toChatRoomMsgText(msg[key]);
    if (text) return text;
  }
  return "";
}

function normalizeChatRoomMsg(msg: NimChatRoomMsg) {
  const text = getChatRoomMsgText(msg);
  return {
    ...msg,
    msg: text,
  };
}

function summarizePayload(payload: string) {
  return payload.replace(/\s+/g, " ").slice(0, 500);
}

function suppressRemoteCommandEcho(payload: string) {
  const command = extractListenTogetherCommandInfo(payload);
  if (!command) return;
  const commandType = normalizeCommandToken(command.commandType);
  const playStatus = normalizeCommandToken(command.playStatus);
  const songId = getCommandSongId(command);
  if (commandType === "PAUSE" || playStatus === "PAUSE") {
    suppressListenTogetherPlaybackResume(songId);
    return;
  }
  if (commandType === "NEXT" || commandType === "PROGRESS" || commandType === "GOTO") {
    suppressListenTogetherRemoteChangeEcho(songId);
  }
}

function reportRemoteListenTogetherEvent(source: string, payload: string) {
  ipcRenderer.send(IPC.LT_REMOTE_EVENT, payload, source);
}

registerCallHandler<[string, string], void>("nim.pageLog", (level, message) => {
  ipcRenderer.send(IPC.LT_PAGE_LOG, level, message);
});

registerCallHandler<[ImEnterParams], [Record<string, unknown>]>(
  "im.enter",
  (params) => {
    const chatRoomId = params.chat_roomid;
    localState.roomId = chatRoomId;
    localState.userId = String(params.userId ?? params.user_id ?? params.account ?? "");
    localState.entered = true;
    imState.connected = true;
    imState.chatRoomId = chatRoomId;

    const result = { code: 200, chatRoomId };

    ["im.onEnter", "im.onConnect", "im.onConnected", "im.onChatroomEntered", "im.onReady", "im.onEnterSuccess"]
      .forEach((event, i) => {
        setTimeout(() => fireNativeCall(event, result), (i + 1) * 30);
      });

    ipcRenderer.send(IPC.NIM_JOIN_CHATROOM, chatRoomId, localState.userId);
    return [result];
  }
);

registerCallHandler<[], [boolean]>("im.leave", () => {
  ipcRenderer.send(IPC.NIM_LEAVE_CHATROOM);
  localState.roomId = null;
  localState.userId = null;
  localState.entered = false;
  imState.connected = false;
  imState.chatRoomId = null;
  return [true];
});

registerCallHandler<[ImSendParams], [boolean]>("im.sendText", async (params) => {
  try {
    const result = await ipcRenderer.invoke(IPC.NIM_SEND_CHATROOM_MSG, { text: params.text, to: params.to });
    return [result?.code === 200];
  } catch (e) {
    console.warn("[im] sendText IPC failed:", e);
    return [true];
  }
});
registerCallHandler<[ImSendParams], [boolean]>("im.sendMsg", async (params) => {
  try {
    const result = await ipcRenderer.invoke(IPC.NIM_SEND_CHATROOM_MSG, { msg: params, to: params.to });
    return [result?.code === 200];
  } catch (e) {
    console.warn("[im] sendMsg IPC failed:", e);
    return [true];
  }
});

registerCallHandler<[], [{ members: never[]; code: number }]>(
  "im.getMembers",
  () => [{ members: [], code: 200 }]
);

registerCallHandler<
  [],
  [{ chatRoom: { id: string | null; name: string; announcement: string }; code: number }]
>("im.getChatRoomInfo", () => [
  { chatRoom: { id: localState.roomId, name: "", announcement: "" }, code: 200 },
]);

registerCallHandler<object[], [boolean]>("im.updateMyInfo", () => [true]);
registerCallHandler<object[], [boolean]>("im.setMemberRole", () => [true]);

registerCallHandler<[string], void>("nim.msg", (payload) => {
  let eventMsg = payload;
  try {
    const msg = JSON.parse(payload);
    if (msg && typeof msg === "object") {
      const normalizedMsg = normalizeChatRoomMsg(msg as NimChatRoomMsg);
      eventMsg = typeof normalizedMsg.msg === "string" ? normalizedMsg.msg : payload;
      console.log(
        "[LT:RECV] nim.msg from:",
        (msg as NimChatRoomMsg).from,
        "type:",
        (msg as NimChatRoomMsg).type,
        "msg:",
        summarizePayload(eventMsg)
      );
      suppressRemoteCommandEcho(eventMsg);
      dispatchChatRoomMsg(normalizedMsg);
    }
  } catch (e) {
    console.warn("[im] failed to parse NIM chat room message:", e);
  }
  fireNativeCall("im.onChatRoomMsg", { msg: eventMsg });
});

registerCallHandler<[string], void>("nim.signal", (payload) => {
  console.log("[LT:SIGNAL] nim.signal received, payload:", summarizePayload(payload));
  reportRemoteListenTogetherEvent("signal", payload);
  fireNativeCall("im.onSignal", { msg: payload });
  fireNativeCall("rtc.onSignal", { msg: payload });
});

registerCallHandler<[], void>("nimsys.enter", () => {
  imState.connected = true;
  ipcRenderer.emit(IPC.LT_CHATROOM_CONNECTED);
  ipcRenderer.send(IPC.LT_CHATROOM_CONNECTED);
});

registerCallHandler<[], void>("nimsys.leave", () => {
  imState.connected = false;
});
