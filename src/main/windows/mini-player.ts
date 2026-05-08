import { join } from "node:path";

import { BrowserWindow } from "electron";

import { mainWindow, setWindowId } from "../window";
import { registerIpcHandlers } from "../../bridge/register";
import {
  MiniPlayerContract,
  MiniPlayerPlayInfo,
  MiniPlayerPlayState,
  MiniPlayerListElement,
  MiniPlayerFullState,
} from "../../bridge/contracts/mini-player-api";
import { dragWindow } from "@open-orpheus/window";
import { registerInputRegionHandlers } from "../../bridge/common/inputRegion";

let miniPlayerWindow: BrowserWindow | null = null;

// State
let playInfo: MiniPlayerPlayInfo | null = null;
let coverUrl: string | null = null;
let likeMark = false;
let currentPlay: string | null = null;
let playState: MiniPlayerPlayState = { playing: false };
let listItems: MiniPlayerListElement[] = [];

function sendToMiniPlayer(event: string, data: unknown) {
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.webContents.send(`miniPlayer.${event}`, data);
  }
}

export function updatePlayInfo(info: MiniPlayerPlayInfo | null) {
  playInfo = info;
  sendToMiniPlayer("playInfoUpdate", info);
}

export function updateCoverUrl(url: string | null) {
  coverUrl = url;
  sendToMiniPlayer("coverUpdate", url);
}

export function updateLikeMark(liked: boolean) {
  likeMark = liked;
  sendToMiniPlayer("likeUpdate", liked);
}

export function updatePlayState(playing: boolean) {
  playState = { playing };
  sendToMiniPlayer("playStateUpdate", playState);
}

export function updateListData(
  items: MiniPlayerListElement[],
  cp: string | null
) {
  listItems = items;
  currentPlay = cp;
  sendToMiniPlayer("listUpdate", { items, currentPlay });
}

export function showVolume(volume: number, muted: boolean) {
  sendToMiniPlayer("showVolume", [volume, muted]);
}

export function getFullState(): MiniPlayerFullState {
  return { playInfo, coverUrl, likeMark, currentPlay, playState, listItems };
}

export default function createMiniPlayerWindow() {
  miniPlayerWindow = new BrowserWindow({
    width: 310,
    height: 50 + 340, // Total size: Main + List
    transparent: true,
    hasShadow: false,
    frame: false,
    resizable: false,
    show: false,
    roundedCorners: false,
    title: "Open Orpheus Mini Player",
    webPreferences: {
      partition: "open-orpheus",
      preload: join(__dirname, "mini-player.js"),
    },
  });
  if (GUI_VITE_DEV_SERVER_URL) {
    miniPlayerWindow.loadURL(`${GUI_VITE_DEV_SERVER_URL}/mini-player`);
  } else {
    miniPlayerWindow.loadURL("gui://frontend/mini-player");
  }
  setWindowId(miniPlayerWindow, "mini_player");

  registerIpcHandlers<MiniPlayerContract>(
    miniPlayerWindow.webContents,
    "miniPlayer",
    {
      requestFullUpdate: async () => getFullState(),
      dragWindow: async () => {
        if (!miniPlayerWindow || miniPlayerWindow.isDestroyed()) return;
        const hwnd = miniPlayerWindow.getNativeWindowHandle();
        dragWindow(hwnd);
      },
      fireCall: async (event, cmd, ...args) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.send("channel.call", cmd, ...args);
      },
    }
  );
  registerInputRegionHandlers(miniPlayerWindow);
}
