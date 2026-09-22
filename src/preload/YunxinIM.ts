import { ipcRenderer } from "electron";
import SDK from "@yxim/nim-web-sdk";

import type {
  NetworkFetchRequest,
  NetworkFetchResponse,
} from "../main/calls/handlers/network";

export default class YunxinIM extends EventTarget {
  static APP_KEY = "3a6a3e48f6854dfa4e4464f3bdaec3b4";

  private nimInst: SDK.NIM | null = null;
  private accountId: string | null = null;

  private chatroom: SDK.Chatroom | null = null;
  private roomId: string | null = null;

  get account() {
    return this.accountId;
  }

  get room() {
    return this.roomId;
  }

  async connect() {
    const res: NetworkFetchResponse = (
      await ipcRenderer.invoke("channel.call", "network.fetch", {
        url: "https://music.163.com/api/middle/im/token/get",
        method: "POST",
        headers: {},
        body: "",
        retryCount: 3,
      } satisfies NetworkFetchRequest)
    )[0];
    if (res.code !== 0 || !res.blob) throw new Error("Cannot fetch IM token");

    const tokenData = JSON.parse(res.blob);

    const account: string | undefined =
      tokenData.data?.accId ?? tokenData.data?.uid;
    const token: string | undefined = tokenData.data?.token;

    if (!account || !token) {
      throw new Error("Cannot fetch IM token");
    }

    this.accountId = account;

    return await new Promise((resolve, reject) => {
      this.nimInst = SDK.NIM.getInstance({
        appKey: YunxinIM.APP_KEY,
        account,
        token,
        db: false,
        syncRelations: false,
        syncFriends: false,
        syncFriendUsers: false,
        syncTeams: false,
        syncExtraTeamInfo: false,
        syncSuperTeams: false,
        syncSessionUnread: false,
        logLevel: "warn",
        onconnect(data) {
          resolve(data);
        },
        ondisconnect(data) {
          LOGGER.warn(`NIM disconnected: ${data}`);
        },
        onerror(data) {
          LOGGER.error(`NIM error: ${data}`);
          reject(data);
        },
        onwillreconnect(data) {
          LOGGER.info({ ...data }, `NIM will reconnect`);
        },
      });
    });
  }

  private disconnectPromise: Promise<unknown> | null = null;
  async disconnect() {
    if (this.disconnectPromise) return await this.disconnectPromise;
    return await (this.disconnectPromise = new Promise((resolve, reject) => {
      if (!this.nimInst) {
        reject();
        return;
      }
      this.nimInst.destroy({
        done: (err, data) => {
          this.nimInst = this.accountId = null;
          if (err) {
            reject(err);
          } else {
            resolve(data);
          }
        },
      });
    }).finally(() => (this.disconnectPromise = null)));
  }

  async joinRoom(roomId: string) {
    if (!this.nimInst) throw new Error("NIM is not initialized");

    const addrResult: Parameters<
      Parameters<typeof this.nimInst.getChatroomAddress>[0]["done"]
    >[1] = await new Promise((resolve, reject) => {
      this.nimInst!.getChatroomAddress({
        chatroomId: roomId,
        done(err, data) {
          if (err) {
            reject(err);
            return;
          }
          resolve(data);
        },
      });
    });

    const addresses = addrResult.address;

    this.roomId = roomId;

    return await new Promise((resolve) => {
      this.chatroom = SDK.Chatroom.getInstance({
        secure: true,
        chatroomAddresses: addresses,
        appKey: YunxinIM.APP_KEY,
        chatroomId: roomId,
        isAnonymous: true,
        account: undefined as unknown as string, // Type-safe: isAnonymous = true
        token: undefined as unknown as string, // Type-safe: isAnonymous = true
        chatroomNick: "listen_together_user",
        logLevel: "warn",
        onconnect(data) {
          resolve(data);
        },
        ondisconnect(data) {
          LOGGER.warn(`Chatroom disconnected: ${data.code}`);
        },
        onwillreconnect(data) {
          LOGGER.info({ ...data }, "Chatroom will reconnect");
        },
        onmsgs: (msgs) => {
          for (const msg of msgs) {
            this.dispatchEvent(
              new CustomEvent(
                "chatroommsg",
                msg.content !== undefined ? { detail: msg.content } : {}
              )
            );
          }
        },
      });
    });
  }

  private leaveRoomPromise: Promise<unknown> | null = null;
  async leaveRoom() {
    if (this.leaveRoomPromise) return await this.leaveRoomPromise;
    return await (this.leaveRoomPromise = new Promise((resolve, reject) => {
      if (!this.chatroom) {
        reject();
        return;
      }
      this.chatroom.destroy({
        done: (err, data) => {
          this.chatroom = this.roomId = null;
          if (err) {
            reject(err);
          } else {
            resolve(data);
          }
        },
      });
    }).finally(() => (this.leaveRoomPromise = null)));
  }
}
