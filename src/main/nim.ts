import { BrowserWindow, WebContents, ipcMain } from "electron";
import client from "./request";
import { serialData } from "./crypto";
import { isRecord, getStringField, getStringParam, summarizeResponseBody } from "../shared/utils";
import {
  extractListenTogetherCommandInfo,
  ListenTogetherCommandInfo,
  LISTEN_TOGETHER_SYNC_MESSAGE_TYPE,
} from "../shared/listenTogetherCommand";
import {
  IPC,
  NIM_APP_KEY,
  PLAY_COMMAND_RETRY_LIMIT,
  PLAY_COMMAND_RETRY_DELAY,
  LISTEN_TOGETHER_SYNC_INTERVAL,
} from "../shared/listenTogetherConstants";

export { type ListenTogetherCommandInfo } from "../shared/listenTogetherCommand";
export { extractListenTogetherCommandInfo } from "../shared/listenTogetherCommand";

export const rtcParams = {
  channelId: "",
  roomId: "",
  userId: "",
  canBroadcastNativePlayCommand: false,
};

let chatroomWebContentsId = 0;
let currentChatroomId = "";
let listenTogetherSyncTimer: NodeJS.Timeout | null = null;
let reverseSyncTimer: NodeJS.Timeout | null = null;
let reverseSyncRunning = false;
let lastReverseSyncSignature = "";
let lastReverseSyncStatusSignature = "";
let chatroomConnectionState: "idle" | "resolving" | "connecting" | "connected" | "leaving" = "idle";
let chatroomSessionSeq = 0;

type RtcEnterParams = Record<string, unknown>;

function waitForRtcContext() {
  if (rtcParams.channelId && rtcParams.roomId) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (rtcParams.channelId && rtcParams.roomId) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - startedAt > 1500) {
        clearInterval(timer);
        console.warn("[NIM] waitForRtcContext timed out without context");
        resolve(false);
      }
    }, 50);
  });
}

function resetDedupeState() {
  lastReverseSyncSignature = "";
  lastReverseSyncStatusSignature = "";
}

function stopListenTogetherSyncFallback() {
  if (!listenTogetherSyncTimer) return;
  clearInterval(listenTogetherSyncTimer);
  listenTogetherSyncTimer = null;
}

function getReverseSyncSignature(commandInfo: ListenTogetherCommandInfo) {
  return [
    rtcParams.roomId,
    commandInfo.clientSeq ?? "",
    commandInfo.commandType ?? "",
    commandInfo.playStatus ?? "",
    commandInfo.formerSongId ?? "",
    commandInfo.targetSongId ?? commandInfo.songId ?? "",
    commandInfo.progress ?? "",
  ].join(":");
}

function isDuplicateCommand(commandInfo: ListenTogetherCommandInfo) {
  const signature = getReverseSyncSignature(commandInfo);
  if (signature === lastReverseSyncSignature) return true;
  lastReverseSyncSignature = signature;
  return false;
}

function dispatchCommandToAllWindows(
  commandInfo: ListenTogetherCommandInfo,
  source: string
) {
  console.log(
    "[LT:REVERSE] apply",
    source,
    commandInfo.commandType,
    commandInfo.playStatus,
    commandInfo.targetSongId ?? commandInfo.songId ?? "",
    commandInfo.progress ?? ""
  );
  let dispatched = false;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(IPC.LT_APPLY_REMOTE_PLAY_COMMAND, commandInfo);
    dispatched = true;
  }
  return dispatched;
}

export function dispatchReverseListenTogetherCommand(
  commandInfo: ListenTogetherCommandInfo,
  source = "unknown"
) {
  if (isDuplicateCommand(commandInfo)) return false;
  return dispatchCommandToAllWindows(commandInfo, source);
}

function dispatchReverseListenTogetherCommandToAll(
  value: unknown,
  source: string
) {
  const commandInfo = extractListenTogetherCommandInfo(value);
  if (!commandInfo) return false;
  return dispatchReverseListenTogetherCommand(commandInfo, source);
}

function extractStatusChatRoomId(body: string) {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.data) || !isRecord(parsed.data.roomInfo)) {
      return "";
    }
    return getStringField(parsed.data.roomInfo, ["chatRoomId", "chatroomId", "chat_roomid"]) ?? "";
  } catch {
    return "";
  }
}

function extractStatusInRoom(body: string): boolean | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.data)) return undefined;
    const inRoom = parsed.data.inRoom;
    if (typeof inRoom === "boolean") return inRoom;
    return undefined;
  } catch {
    return undefined;
  }
}

function logReverseSyncStatus(statusCode: number, body: string) {
  let signature = String(statusCode);
  let summary = summarizeResponseBody(body);
  try {
    const parsed = JSON.parse(body) as unknown;
    if (isRecord(parsed)) {
      const data = isRecord(parsed.data) ? parsed.data : null;
      const roomInfo = data && isRecord(data.roomInfo) ? data.roomInfo : null;
      const users = roomInfo && Array.isArray(roomInfo.roomUsers) ? roomInfo.roomUsers.length : 0;
      const roomId = roomInfo ? getStringField(roomInfo, ["roomId"]) : undefined;
      const chatRoomId = roomInfo ? getStringField(roomInfo, ["chatRoomId"]) : undefined;
      const inRoom = data?.inRoom;
      signature = [statusCode, inRoom, roomId ?? "", chatRoomId ?? "", users].join(":");
      summary = `code=${parsed.code ?? ""} inRoom=${String(inRoom)} roomId=${roomId ?? ""} chatRoomId=${chatRoomId ?? ""} users=${users}`;
    }
  } catch {
    // Keep raw summary for non-JSON responses.
  }

  if (signature === lastReverseSyncStatusSignature) return;
  lastReverseSyncStatusSignature = signature;
  console.log("[LT:POLL] status/get HTTP", statusCode, summary);
}

export function startReverseSyncPoll() {
  if (reverseSyncTimer) {
    stopReverseSyncPoll();
  }
  console.log("[LT:POLL] starting reverse sync poll, roomId:", rtcParams.roomId);
  const sessionRoomId = rtcParams.roomId;

  async function poll() {
    if (!rtcParams.roomId || !rtcParams.channelId || rtcParams.roomId !== sessionRoomId) {
      stopReverseSyncPoll();
      return;
    }
    if (reverseSyncRunning) return;
    reverseSyncRunning = true;
    try {
      const resp = await client.post("https://music.163.com/api/listen/together/status/get", {
        form: { roomId: rtcParams.roomId },
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        throwHttpErrors: false,
      });

      if (rtcParams.roomId !== sessionRoomId) return;

      logReverseSyncStatus(resp.statusCode, resp.body);

      let apiSuccess = false;
      try {
        const parsed = JSON.parse(resp.body);
        apiSuccess = isRecord(parsed) && parsed.code === 200;
      } catch { /* non-JSON */ }

      if (!apiSuccess) return;

      const inRoom = extractStatusInRoom(resp.body);
      if (inRoom === false) {
        console.log("[LT:POLL] server says not in room, triggering leave");
        leaveListenTogether("poll-not-in-room");
        return;
      }

      const chatRoomId = extractStatusChatRoomId(resp.body);
      if (chatRoomId && chatRoomId !== currentChatroomId && chatroomConnectionState === "idle") {
        console.log("[LT:POLL] auto joining chatroom from status/get:", chatRoomId);
        joinListenTogetherChatroom(chatRoomId, rtcParams.userId).catch((e) => {
          console.warn("[NIM] auto joinChatroom failed:", e);
        });
      }

      const commandInfo = extractListenTogetherCommandInfo(resp.body);
      if (commandInfo) {
        dispatchReverseListenTogetherCommand(commandInfo, "poll");
      }
    } catch (e) {
      console.warn("[LT:POLL] status/get failed:", e);
    } finally {
      reverseSyncRunning = false;
    }
  }

  poll();
  reverseSyncTimer = setInterval(poll, LISTEN_TOGETHER_SYNC_INTERVAL);
}

export function stopReverseSyncPoll() {
  if (!reverseSyncTimer) return;
  console.log("[LT:POLL] stopping reverse sync poll");
  clearInterval(reverseSyncTimer);
  reverseSyncTimer = null;
}

export function leaveListenTogether(reason: string) {
  console.log("[LT] leaveListenTogether, reason:", reason);
  stopListenTogetherSyncFallback();
  stopReverseSyncPoll();
  resetDedupeState();
  rtcParams.channelId = "";
  rtcParams.roomId = "";
  rtcParams.userId = "";
  rtcParams.canBroadcastNativePlayCommand = false;
  chatroomWebContentsId = 0;
  currentChatroomId = "";
  chatroomConnectionState = "idle";
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    w.webContents.executeJavaScript(`
      if(window.__nim_chatroom){
        try{window.__nim_chatroom.disconnect({})}catch(e){}
        window.__nim_chatroom=null;
        window.__nim_chatroom_connected=false;
      }
      if(window.__nim_instance){
        try{window.__nim_instance.destroy({})}catch(e){}
        window.__nim_instance=null;
        window.__nim_signaling_channel=null;
      }
      for(var k in window){if(k.startsWith('__nim_ws')){try{window[k].close()}catch(e){}}}
    `).catch(() => {});
  }
}

function startListenTogetherSyncFallback(webContents: WebContents) {
  stopListenTogetherSyncFallback();
  sendListenTogetherSyncFallbackMessage(webContents);
  listenTogetherSyncTimer = setInterval(() => {
    if (webContents.isDestroyed() || !rtcParams.roomId) {
      stopListenTogetherSyncFallback();
      return;
    }
    sendListenTogetherSyncFallbackMessage(webContents);
  }, LISTEN_TOGETHER_SYNC_INTERVAL);
}

function sendListenTogetherSyncFallbackMessage(webContents: WebContents) {
  if (!rtcParams.roomId || webContents.isDestroyed()) return;

  const text = JSON.stringify({
    content: {
      type: LISTEN_TOGETHER_SYNC_MESSAGE_TYPE,
      content: { roomId: rtcParams.roomId },
    },
  });

  webContents.send("channel.call", "nim.msg", JSON.stringify({ type: "text", text }));
}

type ListenTogetherTokenResult =
  | {
      code: 200;
      data: {
        imToken: string;
        imAccId: string;
        imUid: string;
        yunxinToken: string;
        yunxinExpireTime: unknown;
      };
    }
  | { code: -1; message: string };

function stringifyForInjection(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function installPageLogBridge(webContents: WebContents) {
  if (webContents.isDestroyed()) return;
  webContents.executeJavaScript(`
    (function() {
      if (window.__open_orpheus_nim_log_bridge) return;
      window.__open_orpheus_nim_log_bridge = true;
      ['log', 'warn', 'error'].forEach(function(level) {
        var original = console[level];
        console[level] = function() {
          try {
            var args = Array.prototype.slice.call(arguments).map(function(item) {
              if (typeof item === 'string') return item;
              try { return JSON.stringify(item); } catch (e) { return String(item); }
            });
            if (args.length && /^\\[(NIMPage|LT:|YunxinIM|NIM)\\]/.test(args[0])) {
              window.channel.call('nim.pageLog', function(){}, [level, args.join(' ').slice(0, 1000)]);
            }
          } catch (e) {}
          return original.apply(console, arguments);
        };
      });
    })();
  `).catch((e) => {
    console.warn("[NIM] install page log bridge failed:", e);
  });
}

function getAddressList(data: unknown) {
  const raw = getAddressListCandidate(data);
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function getAddressListCandidate(data: unknown): unknown {
  if (!data || typeof data !== "object") return null;
  if (Array.isArray(data)) return data;

  const candidate = data as {
    addr?: unknown;
    address?: unknown;
    addresses?: unknown;
    chatroomAddresses?: unknown;
    data?: unknown;
    items?: unknown;
    result?: unknown;
  };

  if (Array.isArray(candidate.addr)) return candidate.addr;
  if (Array.isArray(candidate.address)) return candidate.address;
  if (Array.isArray(candidate.addresses)) return candidate.addresses;
  if (Array.isArray(candidate.chatroomAddresses)) return candidate.chatroomAddresses;
  if (Array.isArray(candidate.items)) return candidate.items;
  return getAddressListCandidate(candidate.data ?? candidate.result);
}

async function getListenTogetherToken(
  channelId?: string,
  roomId?: string
): Promise<ListenTogetherTokenResult> {
  const cid = channelId || rtcParams.channelId;
  const rid = roomId || rtcParams.roomId;
  if (!cid || !rid) {
    console.warn("[NIM] getListenTogetherToken: missing channelId or roomId");
    return { code: -1, message: "channelId and roomId are required" };
  }

  try {
    const imResp = await client.post("https://music.163.com/api/middle/im/token/get", {
      throwHttpErrors: false,
    });
    const imData = JSON.parse(imResp.body);
    if (imData.code !== 200 || !imData.data?.token) {
      console.warn("[NIM] IM token failed: HTTP", imResp.statusCode, "code:", imData.code);
      return { code: -1, message: "Failed to get IM token" };
    }

    const body = `channelId=${encodeURIComponent(cid)}&roomId=${encodeURIComponent(rid)}`;
    const yxResp = await client.post(
      "https://music.163.com/api/listen/together/yunxin/token/get",
      {
        body,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        throwHttpErrors: false,
      }
    );
    const yxData = JSON.parse(yxResp.body);
    if (yxData.code !== 200 || !yxData.data?.token) {
      console.warn("[NIM] yunxin token failed: HTTP", yxResp.statusCode, "code:", yxData.code);
      return { code: -1, message: "Failed to get yunxin token" };
    }

    return {
      code: 200,
      data: {
        imToken: imData.data.token,
        imAccId: imData.data.accId ?? imData.data.uid ?? "",
        imUid: imData.data.uid ?? "",
        yunxinToken: yxData.data.token,
        yunxinExpireTime: yxData.data.expireTime,
      },
    };
  } catch (e) {
    console.error("[NIM] getListenTogetherToken error:", e);
    return { code: -1, message: String(e) };
  }
}

export async function enterNimRtc(webContents: WebContents, params: RtcEnterParams) {
  installPageLogBridge(webContents);
  const channelName = getStringParam(
    params,
    "channelId",
    "channelName",
    "agoraChannelId",
    "rtcChannelId"
  );
  const roomId = getStringParam(params, "roomId", "roomid", "roomID");
  if (!channelName || !roomId) {
    console.warn("[NIM] enterNimRtc: missing channelName or roomId", params);
    return false;
  }

  const tokenResult = await getListenTogetherToken(channelName, roomId);
  if (tokenResult.code !== 200) {
    console.warn("[NIM] enterNimRtc: token unavailable", tokenResult.message);
    return false;
  }

  const script = `
(function() {
  var params = ${stringifyForInjection(params)};
  var tokenResult = ${stringifyForInjection(tokenResult)};
  var channelName = ${stringifyForInjection(channelName)};
  var appKey = ${stringifyForInjection(NIM_APP_KEY)};

  function emitSignal(eventName, payload) {
    try {
      console.log('[NIMPage] signaling event:', eventName, JSON.stringify(payload).slice(0, 500));
      window.channel.call('nim.signal', function(){}, [JSON.stringify({ eventName: eventName, payload: payload })]);
    } catch (e) {
      console.warn('[NIMPage] signaling event dispatch failed:', e);
    }
  }

  function waitForConnect(nim) {
    if (window.__nim_connected) return Promise.resolve();
    if (window.__nim_connect_promise) return window.__nim_connect_promise;
    var promise = new Promise(function(resolve, reject) {
      var done = false;
      var timer = setTimeout(function() {
        if (done) return;
        done = true;
        window.__nim_connect_promise = null;
        reject(new Error('NIM connect timeout'));
      }, 12000);
      function finish(callback, value) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.__nim_connect_promise = null;
        callback(value);
      }
      window.__nim_connect_resolve = function() {
        finish(resolve);
      };
      window.__nim_connect_reject = function(e) {
        finish(reject, e);
      };
    });
    window.__nim_connect_promise = promise;
    return promise;
  }

  function startSignaling() {
    var SDK = window.SDK;
    if (!SDK || !SDK.NIM) throw new Error('NIM SDK unavailable');
    var data = tokenResult.data || {};
    var account = String(data.imAccId || data.imUid || '');
    var token = String(data.imToken || '');
    if (!account || !token) throw new Error('NIM account/token unavailable');

    var nim = window.__nim_instance;
    if (!nim || window.__nim_account !== account) {
      if (nim) {
        try { nim.destroy({}); } catch (e) {}
      }
      window.__nim_connected = false;
      window.__nim_account = account;
      nim = SDK.NIM.getInstance({
        appKey: appKey,
        account: account,
        token: token,
        db: false,
        syncRelations: false,
        syncFriends: false,
        syncFriendUsers: false,
        syncTeams: false,
        syncExtraTeamInfo: false,
        syncSuperTeams: false,
        syncSessionUnread: false,
        logLevel: 'warn',
        onwillreconnect: function(e) {
          console.warn('[NIMPage] NIM will reconnect:', e && e.retryCount, e && e.duration);
        },
        onconnect: function() {
          window.__nim_connected = true;
          if (window.__nim_connect_resolve) window.__nim_connect_resolve();
          console.log('[NIMPage] NIM connected:', account);
        },
        ondisconnect: function(e) {
          window.__nim_connected = false;
          console.warn('[NIMPage] NIM disconnected:', e && e.code);
          if (window.__nim_connect_reject) window.__nim_connect_reject(e || new Error('NIM disconnected'));
        },
        onerror: function(e) {
          console.warn('[NIMPage] NIM error:', e);
          if (!window.__nim_connected && window.__nim_connect_reject) window.__nim_connect_reject(e);
        }
      });
      ['signalingNotify', 'signalingMutilClientSyncNotify', 'signalingChannelsSyncNotify', 'signalingUnreadMessageSyncNotify', 'signalingEvent', 'signalingMessage', 'signalingCustomNotification'].forEach(function(eventName) {
        try {
          nim.on(eventName, function(payload) {
            emitSignal(eventName, payload);
          });
        } catch (e) {
          console.warn('[NIMPage] signaling listener failed:', eventName, e);
        }
      });
      window.__nim_instance = nim;
    }

    return waitForConnect(nim).then(function() {
      if (window.__nim_signaling_channel && window.__nim_signaling_channel.channelName === channelName) {
        return { ok: true, channel: window.__nim_signaling_channel };
      }
      return nim.signalingCreateAndJoin({
        type: 3,
        channelName: channelName,
        ext: JSON.stringify({ source: 'open-orpheus', roomId: String(params.roomId || '') }),
        attachExt: JSON.stringify({ source: 'open-orpheus', roomId: String(params.roomId || '') }),
        offlineEnabled: false
      }).catch(function(err) {
        console.warn('[NIMPage] signalingCreateAndJoin failed, trying get/join:', err);
        return nim.signalingGetChannelInfo({ channelName: channelName }).then(function(channel) {
          if (!channel || !channel.channelId) throw err;
          return nim.signalingJoin({ channelId: channel.channelId, offlineEnabled: false }).then(function(joined) {
            return joined || channel;
          });
        }).catch(function(joinErr) {
          console.warn('[NIMPage] signaling join unavailable, keeping NIM listeners alive:', joinErr);
          return { channelName: channelName, signalingUnavailable: true };
        });
      }).then(function(channel) {
        window.__nim_signaling_channel = channel;
        console.log('[NIMPage] signaling channel ready:', channel && channel.channelId, channelName);
        return { ok: true, channel: channel };
      });
    });
  }

  function loadAndStart() {
    if (window.SDK && window.SDK.NIM) return startSignaling();
    return new Promise(function(resolve, reject) {
      var script = document.createElement('script');
      script.src = 'orpheus://orpheus/nim/sdk.js';
      script.onload = function() { startSignaling().then(resolve, reject); };
      script.onerror = function() { reject(new Error('Failed to load NIM SDK')); };
      document.head.appendChild(script);
    });
  }

  return loadAndStart().then(function(result) {
    return JSON.stringify(result);
  }).catch(function(e) {
    console.warn('[NIMPage] enter signaling failed:', e);
    return JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) });
  });
})()
`;

  try {
    const raw = await webContents.executeJavaScript(script);
    const result = JSON.parse(String(raw));
    if (!result.ok) console.warn("[NIM] enterNimRtc failed in page:", result.error);
    return result.ok === true;
  } catch (e) {
    console.warn("[NIM] enterNimRtc execute failed:", e);
    return false;
  }
}

export function startListenTogetherSyncFallbackForWebContents(webContents: WebContents) {
  startListenTogetherSyncFallback(webContents);
}

export function enterOrJoinRtc(
  method: "enter" | "join",
  webContents: WebContents,
  params: Record<string, unknown>
) {
  rtcParams.channelId = getStringParam(
    params,
    "channelId",
    "channelName",
    "agoraChannelId",
    "rtcChannelId"
  );
  rtcParams.roomId = getStringParam(params, "roomId", "roomid", "roomID");
  rtcParams.userId = getStringParam(params, "userId", "user_id", "uid");
  rtcParams.canBroadcastNativePlayCommand = true;
  resetDedupeState();
  startListenTogetherSyncFallbackForWebContents(webContents);
  startReverseSyncPoll();
  console.log(`[RTC] ${method}`, rtcParams);

  const resultEvent = method === "enter" ? "rtc.onEnter" : "rtc.onJoin";
  webContents.send("channel.call", resultEvent, {
    code: 200,
    channelId: rtcParams.channelId,
    roomId: rtcParams.roomId,
    roomRTCType: params.roomRTCType ?? "yunxin",
  });

  enterNimRtc(webContents, params)
    .then((ok) => {
      console.log(`[RTC] NIM signaling ${method}`, ok ? "ready" : "failed");
    })
    .catch((error) => {
      console.warn(`[RTC] NIM signaling ${method} error:`, error);
    });
}

ipcMain.on(IPC.NIM_JOIN_CHATROOM, async (event, chatRoomId?: string, userId?: string) => {
  const cid = typeof chatRoomId === "string" ? chatRoomId : "";
  if (!cid) {
    console.warn("[NIM] joinChatroom: no chatRoomId provided, skipping");
    return;
  }
  chatroomWebContentsId = event.sender.id;
  await joinListenTogetherChatroom(cid, userId);
});

async function joinListenTogetherChatroom(chatRoomId: string, userId?: string) {
  const cid = typeof chatRoomId === "string" ? chatRoomId : "";
  if (!cid) return;
  if (chatroomConnectionState !== "idle" && cid === currentChatroomId) {
    console.log("[NIM] chatroom join skipped, already", chatroomConnectionState, "for", cid);
    return;
  }
  chatroomConnectionState = "resolving";
  currentChatroomId = cid;
  const sessionSeq = ++chatroomSessionSeq;
  const isCurrentSession = () => chatroomSessionSeq === sessionSeq;

  try {
    const contextReady = await waitForRtcContext();
    if (!contextReady) {
      console.warn("[NIM] joinListenTogetherChatroom: RTC context not ready, proceeding anyway");
    }
    if (!isCurrentSession()) {
      return;
    }

    const tokenResult = await getListenTogetherToken();
    const accid = tokenResult.code === 200 ? tokenResult.data.imAccId : "";
    const fallbackAccid = typeof userId === "string" && userId ? userId : rtcParams.userId;
    const addressAccid = accid || fallbackAccid;
    const addressBody = addressAccid
      ? `roomid=${encodeURIComponent(cid)}&accid=${encodeURIComponent(addressAccid)}&clienttype=1`
      : `roomid=${encodeURIComponent(cid)}`;
    const eapiParams = serialData("/api/im/getChatroomAddr", addressBody);
    const addrResp = await client.post(
      "https://music.163.com/api/linux/forward",
      {
        body: `eparams=${eapiParams}`,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        throwHttpErrors: false,
      }
    );

    if (!isCurrentSession()) {
      return;
    }

    let addrData: unknown;
    try {
      addrData = JSON.parse(addrResp.body);
    } catch {
      console.warn("[NIM] chatroom addr API returned invalid JSON, falling back to non-eapi endpoint");
      addrData = {};
    }
    const addresses = getAddressList(addrData);
    if (!Array.isArray(addresses) || addresses.length === 0) {
      console.warn(
        "[NIM] chatroom eapi addr empty:",
        addrResp.statusCode,
        summarizeResponseBody(addrResp.body)
      );
      const altResp = await client.post(
        "https://music.163.com/api/im/getChatroomAddr",
        {
          body: addressBody,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          throwHttpErrors: false,
        }
      );

      if (!isCurrentSession()) {
        return;
      }

      let altData: unknown;
      try {
        altData = JSON.parse(altResp.body);
      } catch {
        console.warn("[NIM] fallback chatroom addr API also returned invalid JSON");
        altData = {};
      }
      const addrs = getAddressList(altData);
      if (addrs.length === 0) {
        console.warn(
          "[NIM] chatroom fallback addr empty:",
          altResp.statusCode,
          summarizeResponseBody(altResp.body)
        );
        console.warn("[NIM] no chatroom addresses available, letting SDK resolve chatroom addresses");
      } else {
        addresses.push(...addrs);
      }
    }

    console.log("[NIM] got", addresses.length, "chatroom addresses:", addresses);

    if (!isCurrentSession()) {
      return;
    }

    chatroomConnectionState = "connecting";
    const targets = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
    for (const w of targets) {
      installPageLogBridge(w.webContents);
      const code = `
(function() {
  var chatroomId = ${JSON.stringify(cid)};
  var addresses = ${JSON.stringify(addresses)};
  var appKey = ${stringifyForInjection(NIM_APP_KEY)};
  var sessionToken = ${JSON.stringify(String(sessionSeq))};
  window.__nim_chatroom_session = sessionToken;

  if (!window.SDK || !window.SDK.Chatroom) {
    var script = document.createElement('script');
    script.src = 'orpheus://orpheus/nim/sdk.js';
    script.onload = function() { resolveAddressesAndStart(); };
    script.onerror = function(e) { console.error('[NIMPage] failed to load NIM SDK for chatroom:', e); };
    document.head.appendChild(script);
    return;
  }

  resolveAddressesAndStart();

  function isSessionStale() {
    return window.__nim_chatroom_session !== sessionToken;
  }

  function resolveAddressesAndStart(retryCount) {
    retryCount = retryCount || 0;
    if (isSessionStale()) return;
    if (addresses.length > 0) {
      startChatroom(addresses);
      return;
    }

    var nim = window.__nim_instance;
    if (window.__nim_connected && nim && typeof nim.getChatroomAddress === 'function') {
      try {
        nim.getChatroomAddress({
          chatroomId: chatroomId,
          done: function(err, data) {
            if (err) {
              console.warn('[NIMPage] getChatroomAddress failed:', err);
              if (retryCount < 10) {
                setTimeout(function() { if (!isSessionStale()) resolveAddressesAndStart(retryCount + 1); }, 1000);
              }
              return;
            }
            var resolved = data && Array.isArray(data.address) ? data.address : [];
            console.log('[NIMPage] getChatroomAddress resolved:', resolved.length);
            startChatroom(resolved);
          }
        });
        return;
      } catch (e) {
        console.warn('[NIMPage] getChatroomAddress threw:', e);
      }
    }

    if (retryCount < 10) {
      console.log('[NIMPage] chatroom address lookup waiting for NIM connected:', retryCount);
      setTimeout(function() { if (!isSessionStale()) resolveAddressesAndStart(retryCount + 1); }, 1000);
      return;
    }

    console.warn('[NIMPage] chatroom addresses unavailable after waiting for NIM address API');
  }

  function startChatroom(resolvedAddresses) {
    try {
      if (isSessionStale()) return;
      var SDK = window.SDK;
      if (!SDK || !SDK.Chatroom) { console.error('[NIMPage] SDK not loaded'); return; }
      if (!Array.isArray(resolvedAddresses) || resolvedAddresses.length === 0) {
        console.warn('[NIMPage] chatroom addresses empty, skip init:', chatroomId);
        return;
      }

      if (window.__nim_chatroom) {
        try { window.__nim_chatroom.disconnect({}); } catch(e) {}
        window.__nim_chatroom = null;
      }
      window.__nim_chatroom_connected = false;

      var chatroomOptions = {
        appKey: appKey,
        chatroomId: chatroomId,
        isAnonymous: true,
        chatroomNick: 'listen_together_user',
        logLevel: 'warn',
        onerror: function(e) {
          console.error('[NIMPage] chatroom error:', e && e.code, e);
        },
        onwillreconnect: function(e) {
          console.warn('[NIMPage] chatroom reconnecting:', e && e.retryCount, e && e.duration);
        },
        onconnect: function() {
          window.__nim_chatroom_connected = true;
          window.channel.call('nimsys.enter', function(){}, []);
          console.log('[NIMPage] chatroom connected (anonymous)! id:', chatroomId);
        },
        ondisconnect: function(e) {
          window.__nim_chatroom_connected = false;
          window.channel.call('nimsys.leave', function(){}, []);
          console.log('[NIMPage] chatroom disconnected:', e && e.code);
        },
        onmsgs: function(msgs) {
          for (var i = 0; i < msgs.length; i++) {
            var msg = msgs[i];
            console.log('[NIMPage] chatroom msg, type:', msg.type, 'from:', msg.from, 'text:', String(msg.text || msg.msg || '').slice(0, 500));
            try {
              window.channel.call('nim.msg', function(){}, [JSON.stringify(msg)]);
            } catch(ex) {}
          }
        }
      };
      chatroomOptions.chatroomAddresses = resolvedAddresses;

      var chatroom = SDK.Chatroom.getInstance(chatroomOptions);
      if (chatroom && typeof chatroom.connect === 'function') {
        setTimeout(function() {
          if (!window.__nim_chatroom_connected) {
            try {
              console.log('[NIMPage] chatroom connect retry:', chatroomId);
              chatroom.connect();
            } catch (e) {
              console.warn('[NIMPage] chatroom connect retry failed:', e);
            }
          }
        }, 1000);
      }

      window.__nim_chatroom = chatroom;
      console.log('[NIMPage] anonymous chatroom instance created');
    } catch(e) {
      console.error('[NIMPage] chatroom init error:', e);
    }
  }
})();
`;
      w.webContents.executeJavaScript(code).catch((e) => {
        console.error("[NIM] executeJavaScript error:", e);
      });
    }
    chatroomConnectionState = "connecting";
  } catch (e) {
    console.error("[NIM] joinChatroom error:", e);
    chatroomConnectionState = "idle";
  }
}

ipcMain.on(IPC.NIM_LEAVE_CHATROOM, () => {
  leaveListenTogether("nim.leaveChatroom");
});

ipcMain.on(IPC.NIM_LEAVE, () => {
  leaveListenTogether("nim.leave");
});

ipcMain.on(IPC.LT_CHATROOM_CONNECTED, () => {
  if (chatroomConnectionState === "connecting") {
    chatroomConnectionState = "connected";
    console.log("[NIM] chatroom connection confirmed by renderer");
  }
});

ipcMain.on(IPC.LT_REMOTE_EVENT, (_event, payload: string, source: string) => {
  dispatchReverseListenTogetherCommandToAll(payload, source);
});

ipcMain.on(IPC.LT_PAGE_LOG, (_event, level: string, message: string) => {
  const method = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  method("[LT:PAGE]", message);
});

ipcMain.handle(IPC.NIM_SEND_CHATROOM_MSG, async (event, msg: { text?: string; msg?: unknown; to: string }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { code: -1 };

  const text = msg.text ?? (typeof msg.msg === "string" ? msg.msg : JSON.stringify(msg.msg));

  try {
    const raw = await win.webContents.executeJavaScript(`
      (function() {
        var cr = window.__nim_chatroom;
        if (!cr) return JSON.stringify({ ok: false, error: 'chatroom not connected' });
        try {
          cr.sendText({
            text: ${JSON.stringify(text)},
            done: function(err) {
              if (err) console.warn('[NIMPage] sendText error:', err);
            }
          });
          return JSON.stringify({ ok: true });
        } catch(e) {
          return JSON.stringify({ ok: false, error: e.message || String(e) });
        }
      })()
    `);
    const result = JSON.parse(raw);
    return { code: result.ok ? 200 : -1 };
  } catch (e) {
    console.warn("[NIM] sendChatRoomMsg error:", e);
    return { code: -1 };
  }
});

export function broadcastListenTogetherPlayCommand(commandInfo: ListenTogetherCommandInfo) {
  console.log("[LT:SEND] broadcast", commandInfo.commandType, commandInfo.playStatus, commandInfo.targetSongId);
  if (!commandInfo.userId && rtcParams.userId) {
    commandInfo.userId = Number.isNaN(Number(rtcParams.userId))
      ? rtcParams.userId
      : Number(rtcParams.userId);
  }
  const text = JSON.stringify({
    content: {
      type: 20000,
      content: commandInfo,
    },
  });

  const sessionRoomId = rtcParams.roomId;
  const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  console.log("[LT:SEND] chatroomWebContentsId:", chatroomWebContentsId, "broadcasting to all", windows.length, "windows");

  for (const win of windows) {
    sendListenTogetherTextToWindow(win, text, 0, sessionRoomId);
  }
}

function sendListenTogetherTextToWindow(win: BrowserWindow, text: string, attempt: number, sessionRoomId: string) {
  if (rtcParams.roomId !== sessionRoomId) return;

  const retryLimit = attempt < PLAY_COMMAND_RETRY_LIMIT;
  win.webContents
    .executeJavaScript(`
        (function() {
          var cr = window.__nim_chatroom;
          if (!cr) return JSON.stringify({ ok: false, retry: ${JSON.stringify(retryLimit)}, error: 'chatroom not connected' });
          if (!window.__nim_chatroom_connected) return JSON.stringify({ ok: false, retry: ${JSON.stringify(retryLimit)}, error: 'chatroom connecting' });
          try {
            cr.sendText({ text: ${JSON.stringify(text)} });
            return JSON.stringify({ ok: true });
          } catch (e) {
            return JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) });
          }
        })()
      `)
    .then((raw) => {
      try {
        const result = JSON.parse(String(raw));
        if (result.ok) {
          console.log("[LT:SEND] sendText OK, window:", win.id);
          return;
        }
        if (result.retry && attempt < PLAY_COMMAND_RETRY_LIMIT) {
          console.log("[LT:SEND] sendText retry", attempt + 1, "window:", win.id, "error:", result.error);
          setTimeout(() => {
            if (!win.isDestroyed()) sendListenTogetherTextToWindow(win, text, attempt + 1, sessionRoomId);
          }, PLAY_COMMAND_RETRY_DELAY);
          return;
        }
        console.warn("[NIM] broadcast play command failed:", result.error);
        sendListenTogetherSyncFallbackMessage(win.webContents);
      } catch (e) {
        console.warn("[NIM] broadcast play command parse failed:", e);
        sendListenTogetherSyncFallbackMessage(win.webContents);
      }
    })
    .catch((e) => {
      console.warn("[NIM] broadcast play command execute failed:", e);
      sendListenTogetherSyncFallbackMessage(win.webContents);
    });
}

ipcMain.handle(IPC.NIM_GET_LISTEN_TOGETHER_TOKEN, async (_event, channelId?: string, roomId?: string) => {
  return getListenTogetherToken(channelId, roomId);
});

ipcMain.handle(IPC.NIM_ENTER_RTC, async (event, params: RtcEnterParams) => {
  rtcParams.channelId = getStringParam(
    params,
    "channelId",
    "channelName",
    "agoraChannelId",
    "rtcChannelId"
  );
  rtcParams.roomId = getStringParam(params, "roomId", "roomid", "roomID");
  rtcParams.userId = getStringParam(params, "userId", "user_id", "uid");
  rtcParams.canBroadcastNativePlayCommand = true;
  resetDedupeState();
  startListenTogetherSyncFallback(event.sender);
  startReverseSyncPoll();
  const ok = await enterNimRtc(event.sender, params);
  return { code: ok ? 200 : -1 };
});

ipcMain.on(IPC.LT_NATIVE_PLAY_COMMAND, (_event, commandInfo: ListenTogetherCommandInfo) => {
  console.log("[LT:IPC] nativePlayCommand, canBroadcast:", rtcParams.canBroadcastNativePlayCommand, "type:", commandInfo.commandType);
  if (!rtcParams.canBroadcastNativePlayCommand) {
    console.log("[LT:IPC] blocked: canBroadcastNativePlayCommand=false");
    return;
  }

  if (rtcParams.channelId && rtcParams.roomId) {
    const body = `channelId=${encodeURIComponent(rtcParams.channelId)}&roomId=${encodeURIComponent(rtcParams.roomId)}&commandInfo=${encodeURIComponent(JSON.stringify(commandInfo))}`;
    client.post("https://music.163.com/api/listen/together/play/command/report", {
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      throwHttpErrors: false,
    }).then((resp) => {
      console.log("[LT:API] HTTP", resp.statusCode, "body:", resp.body.slice(0, 300));
    }).catch((e) => {
      console.warn("[LT:API] HTTP failed:", e);
    });
  }
});
