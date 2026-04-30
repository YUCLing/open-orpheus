export const IPC = {
  NIM_JOIN_CHATROOM: "nim.joinChatroom",
  NIM_LEAVE_CHATROOM: "nim.leaveChatroom",
  NIM_LEAVE: "nim.leave",
  NIM_SEND_CHATROOM_MSG: "nim.sendChatRoomMsg",
  NIM_GET_LISTEN_TOGETHER_TOKEN: "nim.getListenTogetherToken",
  NIM_ENTER_RTC: "nim.enterRtc",
  LT_APPLY_REMOTE_PLAY_COMMAND: "listenTogether.applyRemotePlayCommand",
  LT_NATIVE_PLAY_COMMAND: "listenTogether.nativePlayCommand",
  LT_REMOTE_EVENT: "listenTogether.remoteEvent",
  LT_PAGE_LOG: "listenTogether.pageLog",
  LT_CHATROOM_CONNECTED: "listenTogether.chatroomConnected",
} as const;

export const NIM_APP_KEY = "3a6a3e48f6854dfa4e4464f3bdaec3b4";

export const PLAY_COMMAND_RETRY_LIMIT = 6;
export const PLAY_COMMAND_RETRY_DELAY = 500;
export const LISTEN_TOGETHER_SYNC_INTERVAL = 2000;
export const LISTEN_TOGETHER_REMOTE_PAUSE_SUPPRESS_MS = 2500;
export const LISTEN_TOGETHER_PLAY_SUPPRESS_MS = 1500;
export const LISTEN_TOGETHER_PROGRESS_SYNC_THRESHOLD = 1.5;
export const LISTEN_TOGETHER_PROGRESS_COOLDOWN_MS = 3000;
export const LISTEN_TOGETHER_REMOTE_CHANGE_SUPPRESS_MS = 4000;
