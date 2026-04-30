import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/listenTogetherConstants";

(window as unknown as Record<string, unknown>).__YUNXIN_LOADED__ = true;

type ConnectionState = "disconnected" | "connecting" | "connected";
type ChatRoomState = "none" | "entering" | "entered";
type YunxinPayload = Record<string, unknown>;
type Callback = (data: YunxinPayload) => void;

let imEnterCallback: Callback | null = null;
export let chatRoomMsgCallback: Callback | null = null;

let connectionState: ConnectionState = "disconnected";
let chatRoomState: ChatRoomState = "none";
let loginSessionId = 0;

export const imState: { connected: boolean; chatRoomId: string | null } = {
  connected: false,
  chatRoomId: null,
};

const setConnectionState = (nextState: ConnectionState) => {
  connectionState = nextState;
  imState.connected = nextState === "connected";
};

const setChatRoomState = (nextState: ChatRoomState, chatRoomId: string | null) => {
  chatRoomState = nextState;
  imState.chatRoomId = chatRoomId;
};

const resetIMState = () => {
  setConnectionState("disconnected");
  setChatRoomState("none", null);
};

const buildEnterResult = (): YunxinPayload => ({
  code: 200,
  chatRoomId: imState.chatRoomId,
});

export const dispatchChatRoomMsg = (msg: YunxinPayload) => {
  if (!chatRoomMsgCallback) {
    console.log("[YunxinIM] chat room message ignored, callback not registered");
    return;
  }

  console.log("[YunxinIM] dispatching chat room message");
  chatRoomMsgCallback(msg);
};

contextBridge.exposeInMainWorld("YunxinIM", {
  get logged() {
    return imState.connected;
  },

  loginIM: async (chatRoomId: string, userId?: string | number) => {
    console.log("[YunxinIM] loginIM called, chatRoomId:", chatRoomId);
    const currentSession = ++loginSessionId;
    setConnectionState("connecting");
    setChatRoomState("entering", chatRoomId);

    ipcRenderer.send(IPC.NIM_JOIN_CHATROOM, chatRoomId, userId ? String(userId) : "");

    const confirmTimeout = new Promise<void>((resolve) => {
      const onConnected = () => {
        ipcRenderer.removeListener(IPC.LT_CHATROOM_CONNECTED, onConnected);
        resolve();
      };
      ipcRenderer.once(IPC.LT_CHATROOM_CONNECTED, onConnected);
      setTimeout(() => {
        ipcRenderer.removeListener(IPC.LT_CHATROOM_CONNECTED, onConnected);
        resolve();
      }, 5000);
    });
    await confirmTimeout;

    if (loginSessionId !== currentSession) {
      console.log("[YunxinIM] loginIM stale session, ignoring");
      return { code: -1, chatRoomId };
    }

    setConnectionState("connected");
    console.log("[YunxinIM] IM connected");

    setChatRoomState("entered", chatRoomId);
    console.log("[YunxinIM] chat room entered, chatRoomId:", chatRoomId);

    const result = { code: 200, chatRoomId };
    if (imEnterCallback) {
      console.log("[YunxinIM] firing subscribeYunXinIMEnter callback");
      imEnterCallback(result);
    }
    return result;
  },

  logout: () => {
    console.log("[YunxinIM] logout called");
    loginSessionId++;
    ipcRenderer.send(IPC.NIM_LEAVE_CHATROOM);
    resetIMState();
    return Promise.resolve({ code: 200 });
  },

  enterRTC: async (params: YunxinPayload) => {
    try {
      const tokenResult = await ipcRenderer.invoke(
        IPC.NIM_GET_LISTEN_TOGETHER_TOKEN,
        String(params.channelId ?? ""),
        String(params.roomId ?? "")
      );
      ipcRenderer.invoke(IPC.NIM_ENTER_RTC, params).catch((e) => {
        console.warn("[YunxinIM] enterRTC signaling failed:", e);
      });
      return {
        code: 200,
        ...tokenResult,
        data: {
          ...(tokenResult?.data ?? {}),
          roomId: params.roomId ?? "",
          channelId: params.channelId ?? "",
          roomRTCType: params.roomRTCType ?? "yunxin",
        },
      };
    } catch (e) {
      console.warn("[YunxinIM] enterRTC failed:", e);
      return { code: -1, message: String(e) };
    }
  },

  leaveRTC: () => {
    console.log("[YunxinIM] leaveRTC called");
    return Promise.resolve({ code: 200 });
  },

  leaveIM: () => {
    console.log("[YunxinIM] leaveIM called");
    loginSessionId++;
    ipcRenderer.send(IPC.NIM_LEAVE_CHATROOM);
    setChatRoomState("none", null);
    return Promise.resolve({ code: 200 });
  },

  subscribeYunXinIMEnter: (callback: Callback) => {
    console.log("[YunxinIM] subscribeYunXinIMEnter registered");
    imEnterCallback = callback;
    if (connectionState === "connected" && chatRoomState === "entered") {
      callback(buildEnterResult());
    }
  },

  subscribeYunXinIMChatRoomMsg: (callback: Callback) => {
    console.log("[YunxinIM] subscribeYunXinIMChatRoomMsg registered");
    chatRoomMsgCallback = callback;
  },
});
