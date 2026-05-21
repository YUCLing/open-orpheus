import { dirname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { BrowserWindow, ipcMain } from "electron";
import photon from "@silvia-odwyer/photon-node";

import { mainWindow, setWindowId } from "../window";
import { dragWindow } from "@open-orpheus/window";
import { sanitizeRelativePath } from "../util";
import { storage } from "../folders";
import { quitting } from "../lifecycle";
import { registerIpcHandlers } from "../../bridge/register";
import type { DesktopLyricsContract } from "../../bridge/contracts/desktop-lyrics-api";
import { registerInputRegionHandlers } from "../../bridge/common/inputRegion";
import { registerLyricsHandlers } from "../../bridge/common/lyrics";

let desktopLyricsWindow: BrowserWindow | null = null;

function sendToLyricsWindow(channel: string, data: unknown) {
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    desktopLyricsWindow.webContents.send(channel, data);
  }
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
    if (quitting) return; // If the app is quitting we allow the window to close
    // Not closing, but telling NCM to hide.
    e.preventDefault();
    performAction("close");
  });

  registerIpcHandlers<DesktopLyricsContract>(
    desktopLyricsWindow.webContents,
    "desktopLyrics",
    {
      requestFullUpdate: async () => {
        if (mainWindow) {
          mainWindow.webContents.send("desktopLyrics.sendFullState");
        }
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
}

// --- IPC handlers ---

ipcMain.handle(
  "desktopLyrics.updateStyle",
  (_event, styleUpdate: Record<string, unknown>) => {
    sendToLyricsWindow("desktopLyrics.styleUpdate", styleUpdate);
  }
);

ipcMain.handle("desktopLyrics.setLocked", (_event, locked: boolean) => {
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    desktopLyricsWindow.setResizable(!locked);
  }
  sendToLyricsWindow("desktopLyrics.setLocked", locked);
});

ipcMain.handle("desktopLyrics.show", () => {
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    desktopLyricsWindow.show();
  }
});

ipcMain.handle("desktopLyrics.hide", () => {
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    desktopLyricsWindow.hide();
  }
});

ipcMain.handle("desktopLyrics.setTopMost", (_event, topMost: boolean) => {
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    desktopLyricsWindow.setAlwaysOnTop(topMost);
  }
});

ipcMain.handle(
  "desktopLyrics.renderPreview",
  async (
    _event,
    style: Record<string, unknown>,
    text: string,
    path: string
  ) => {
    const filePath = sanitizeRelativePath(storage, path);
    if (filePath === false) {
      console.warn(
        "Attempted to save desktop lyrics preview to invalid path:",
        path
      );
      return;
    }
    const [buf, size] = await createDesktopLyricsPreview(style, text);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, buf);
    return size;
  }
);

// --- Preview ---

export async function createDesktopLyricsPreview(
  style: Record<string, unknown>,
  text: string
): Promise<[Buffer, [number, number]]> {
  const vertical = !!style.vertical;
  const [width, height] = vertical ? [124, 310] : [310, 124];

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

  if (GUI_VITE_DEV_SERVER_URL) {
    previewWindow.loadURL(`${GUI_VITE_DEV_SERVER_URL}/desktop-lyrics-preview`);
  } else {
    previewWindow.loadURL("gui://frontend/desktop-lyrics-preview");
  }

  return new Promise<[Buffer, [number, number]]>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!previewWindow.isDestroyed()) previewWindow.close();
      reject(new Error("Preview generation timed out"));
    }, 10000);

    previewWindow.webContents.ipc.handle(
      "desktopLyricsPreview.requestInit",
      () => ({ style, text })
    );

    previewWindow.webContents.ipc.handle(
      "desktopLyricsPreview.ready",
      async () => {
        clearTimeout(timeout);
        try {
          const image = await previewWindow.webContents.capturePage();
          const photonImage = photon.PhotonImage.new_from_byteslice(
            image.toPNG()
          );
          const pngBuf = photon
            .resize(photonImage, width, height, photon.SamplingFilter.Lanczos3)
            .get_bytes();
          resolve([Buffer.from(pngBuf), [width, height]]);
        } catch (err) {
          reject(err);
        } finally {
          setImmediate(() => previewWindow.close());
        }
      }
    );
  });
}
