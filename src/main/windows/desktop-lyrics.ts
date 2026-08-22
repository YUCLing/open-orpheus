import { join } from "node:path";

import { BrowserWindow, screen } from "electron";
import photon from "@silvia-odwyer/photon-node";
import {
  DesktopEnvironment,
  dragWindow,
  getDesktopEnvironment,
} from "@open-orpheus/window";

import {
  DesktopLyricsPlayInfo,
  LineMode,
  LyricsStyle,
  ShowTranslate,
  TextAlignType,
} from "$sharedTypes/desktop-lyrics";

import {
  mainWindow,
  ManagedWindow,
  OnDemandWindow,
  OnDemandWindowState,
  SimpleManagedWindow,
} from "../window";
import { LifecycleState, state as lifecycleState } from "../lifecycle";
import { registerIpcHandlers } from "../../bridge/register";
import type {
  DesktopLyricsContract,
  DesktopLyricsPreviewContract,
} from "../../bridge/contracts/desktop-lyrics-api";
import { registerInputRegionHandlers } from "../../bridge/common/inputRegion";
import { registerLyricsHandlers } from "../../bridge/common/lyrics";
import { registerSettingsHandlers } from "../../bridge/common/settings";
import { kv as settings } from "../settings";

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
  return window.send("desktopLyrics.styleUpdate", lyricsStyle);
}

export let lyricsOffset = 0;
export function setLyricsOffset(offset: number) {
  lyricsOffset = offset;
  return window.send("desktopLyrics.offsetUpdate", offset);
}

export let lyricsLocked = false;
export function setLyricsLocked(locked: boolean) {
  lyricsLocked = locked;
  return window.send("desktopLyrics.lockUpdate", locked);
}

let lyricsPlayInfo: DesktopLyricsPlayInfo | null = null;
export function updateLyricsPlayInfo(info: DesktopLyricsPlayInfo | null) {
  lyricsPlayInfo = info;
  return window.send("desktopLyrics.playInfoUpdate", info);
}

function performAction(action: string) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(
      "channel.call",
      "player.ondesktoplyricaction",
      action
    );
  }
}

function createWindow(state?: OnDemandWindowState): BrowserWindow {
  const desktopLyricsWindow = new BrowserWindow({
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

  desktopLyricsWindow.on("blur", () => {
    if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return;
    desktopLyricsWindow.webContents.send("desktopLyrics.blur");
  });

  desktopLyricsWindow.on("close", (e) => {
    if ((state && !state.alive) || lifecycleState === LifecycleState.Quitting)
      return; // Only allow direct close when not triggered externally or quitting
    // Not closing, but telling NCM to hide.
    e.preventDefault();
    performAction("close");
  });

  const de = getDesktopEnvironment();

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
        updateLyricsPlayInfo(lyricsPlayInfo);
      },
      performAction: async (_event, action: string) => {
        performAction(action);
      },
      onMouseWheel: async (
        _event,
        pageX: number,
        pageY: number,
        delta: number,
        modifier = 0
      ) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        let x = pageX;
        let y = pageY;
        if (de !== DesktopEnvironment.Wayland) {
          const scrCursor = screen.getCursorScreenPoint();
          [x, y] = [scrCursor.x, scrCursor.y];
        }
        mainWindow.webContents.send(
          "channel.call",
          "player.ondesktopmousewheel",
          modifier,
          delta,
          x,
          y
        );
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

  return desktopLyricsWindow;
}

class DesktopLyricsOnDemandWindow extends OnDemandWindow {
  createWindow(state: OnDemandWindowState): BrowserWindow {
    return createWindow(state);
  }
}

export let window: ManagedWindow;
export default async function createDesktopLyricsWindow() {
  window =
    (await settings.get("window.lifecycle")) !== "on-demand"
      ? new SimpleManagedWindow(createWindow())
      : new DesktopLyricsOnDemandWindow();
  window.setData("name", "desktop_lyrics");
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
