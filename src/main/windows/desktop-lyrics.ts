import { join } from "node:path";

import { BrowserWindow } from "electron";
import photon from "@silvia-odwyer/photon-node";
import { dragWindow } from "@open-orpheus/window";

import {
  LineMode,
  LyricsStyle,
  ShowTranslate,
  TextAlignType,
} from "$sharedTypes/desktop-lyrics";

import { mainWindow, setWindowId } from "../window";
import { LifecycleState, state as lifecycleState } from "../lifecycle";
import { registerIpcHandlers } from "../../bridge/register";
import type {
  DesktopLyricsContract,
  DesktopLyricsPreviewContract,
} from "../../bridge/contracts/desktop-lyrics-api";
import { registerInputRegionHandlers } from "../../bridge/common/inputRegion";
import { registerLyricsHandlers } from "../../bridge/common/lyrics";
import { registerSettingsHandlers } from "../../bridge/common/settings";

export let desktopLyricsWindow: BrowserWindow | null = null;

export const lyricsStyle: LyricsStyle = {
  font: {
    family: "sans-serif",
    size: 36,
    weight: "normal",
  },
  textAlign: [TextAlignType.Center, TextAlignType.Center],
  lineMode: LineMode.Single,
  vertical: false,
  color: {
    notPlayed: {
      top: "#ffffff",
      bottom: "#cccccc",
    },
    played: {
      top: "#00ff88",
      bottom: "#00cc66",
    },
  },
  outline: {
    notPlayed: "transparent",
    played: "transparent",
  },
  dropShadow: false,
  showTranslate: ShowTranslate.Translate,
};
export function refreshLyricsStyle() {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return false;
  desktopLyricsWindow.webContents.send(
    "desktopLyrics.styleUpdate",
    lyricsStyle
  );
  return true;
}

export let lyricsOffset = 0;
export function setLyricsOffset(offset: number) {
  lyricsOffset = offset;
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return false;
  desktopLyricsWindow.webContents.send("desktopLyrics.offsetUpdate", offset);
  return true;
}

export let lyricsLocked = false;
export function setLyricsLocked(locked: boolean) {
  lyricsLocked = locked;
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return false;
  desktopLyricsWindow.webContents.send("desktopLyrics.lockUpdate", locked);
  return true;
}

function performAction(action: string) {
  if (mainWindow) {
    mainWindow.webContents.send(
      "channel.call",
      "player.ondesktoplyricaction",
      action
    );
  }
}

export default function createDesktopLyricsWindow() {
  desktopLyricsWindow = new BrowserWindow({
    width: 800, // TODO: Proper sizes
    height: 225,
    skipTaskbar: true,
    transparent: true,
    hasShadow: false,
    frame: false,
    resizable: true,
    show: false,
    title: "Open Orpheus Lyrics",
    webPreferences: {
      partition: "open-orpheus",
      preload: join(__dirname, "desktop-lyrics.js"),
    },
  });
  if (GUI_VITE_DEV_SERVER_URL) {
    desktopLyricsWindow.loadURL(`${GUI_VITE_DEV_SERVER_URL}/desktop-lyrics`);
  } else {
    desktopLyricsWindow.loadURL("gui://frontend/desktop-lyrics");
  }
  setWindowId(desktopLyricsWindow, "desktop_lyrics");

  desktopLyricsWindow.on("close", (e) => {
    if (lifecycleState === LifecycleState.Quitting) return; // If the app is quitting we allow the window to close
    // Not closing, but telling NCM to hide.
    e.preventDefault();
    performAction("close");
  });

  registerIpcHandlers<DesktopLyricsContract>(
    desktopLyricsWindow.webContents,
    "desktopLyrics",
    {
      requestFullUpdate: async () => {
        if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return;
        // Can trigger updates
        refreshLyricsStyle();
        setLyricsOffset(lyricsOffset);
        setLyricsLocked(lyricsLocked);
      },
      performAction: async (_event, action: string) => {
        performAction(action);
      },
      changeOrientation: async () => {
        if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return;
        const sz = desktopLyricsWindow.getSize();
        desktopLyricsWindow.setSize(sz[1], sz[0]);
      },
      dragWindow: async () => {
        if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return;
        const hwnd = desktopLyricsWindow.getNativeWindowHandle();
        dragWindow(hwnd);
      },
    }
  );
  registerInputRegionHandlers(desktopLyricsWindow);
  registerLyricsHandlers(desktopLyricsWindow);
  registerSettingsHandlers(desktopLyricsWindow);
}

// --- Preview ---

export async function createDesktopLyricsPreview(
  style: LyricsStyle,
  text: string
): Promise<[Buffer, [number, number]]> {
  const [width, height] = style.vertical ? [124, 310] : [310, 124];

  const previewWindow = new BrowserWindow({
    width,
    height,
    show: false,
    transparent: true,
    hasShadow: false,
    frame: false,
    resizable: false,
    useContentSize: true,
    webPreferences: {
      offscreen: true,
      partition: "open-orpheus",
      preload: join(__dirname, "desktop-lyrics-preview.js"),
    },
  });

  return new Promise<[Buffer, [number, number]]>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!previewWindow.isDestroyed()) previewWindow.close();
      reject(new Error("Preview generation timed out"));
    }, 10000);

    registerIpcHandlers<DesktopLyricsPreviewContract>(
      previewWindow.webContents,
      "desktopLyricsPreview",
      {
        requestInit: async () => ({ style, text }),
        ready: async () => {
          clearTimeout(timeout);
          try {
            const image = await previewWindow.webContents.capturePage();
            const photonImage = photon.PhotonImage.new_from_byteslice(
              image.toPNG()
            );
            const pngBuf = photon
              .resize(
                photonImage,
                width,
                height,
                photon.SamplingFilter.Lanczos3
              )
              .get_bytes();
            resolve([Buffer.from(pngBuf), [width, height]]);
          } catch (err) {
            reject(err);
          } finally {
            setImmediate(() => previewWindow.close());
          }
        },
      }
    );

    if (GUI_VITE_DEV_SERVER_URL) {
      previewWindow.loadURL(
        `${GUI_VITE_DEV_SERVER_URL}/desktop-lyrics-preview`
      );
    } else {
      previewWindow.loadURL("gui://frontend/desktop-lyrics-preview");
    }
  });
}
