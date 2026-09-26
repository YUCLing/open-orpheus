import { join } from "node:path";

import { BrowserWindow, screen } from "electron";
import type { BrowserWindowConstructorOptions } from "electron";
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
  guiUrl,
  mainWindow,
  ManagedWindow,
  OnDemandWindow,
  switchWindowPolicy,
} from "../window";
import { registerIpcHandlers } from "../../bridge/register";
import type {
  DesktopLyricsContract,
  DesktopLyricsPreviewContract,
} from "../../bridge/contracts/desktop-lyrics-api";
import { registerInputRegionHandlers } from "../../bridge/common/inputRegion";
import { registerLyricsHandlers } from "../../bridge/common/lyrics";
import { registerSettingsHandlers } from "../../bridge/common/settings";
import { events as settingsEvents, kv as settings } from "../settings";

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

const desktopLyricsWindowOptions = {
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
    preload: join(import.meta.dirname, "desktop-lyrics.js"),
  },
} satisfies BrowserWindowConstructorOptions;

function setupDesktopLyricsWindow(wnd: BrowserWindow): BrowserWindow {
  void wnd.loadURL(guiUrl("/desktop-lyrics"));

  wnd.on("blur", () => {
    if (wnd.isDestroyed()) return;
    wnd.webContents.send("desktopLyrics.blur");
  });

  const de = getDesktopEnvironment();

  registerIpcHandlers<DesktopLyricsContract>(wnd.webContents, "desktopLyrics", {
    requestFullUpdate: async () => {
      if (wnd.isDestroyed()) return;
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
      if (wnd.isDestroyed()) return;
      const sz = wnd.getSize();
      wnd.setSize(sz[1], sz[0]);
    },
    dragWindow: async () => {
      if (wnd.isDestroyed()) return;
      const hwnd = wnd.getNativeWindowHandle();
      dragWindow(hwnd);
    },
  });
  registerInputRegionHandlers(wnd);
  registerLyricsHandlers(wnd);
  registerSettingsHandlers(wnd);

  return wnd;
}

/** Closing the window tells the player to hide the lyrics instead. */
function notifyDesktopLyricsClose() {
  performAction("close");
}

class DesktopLyricsWindow extends ManagedWindow {
  constructor() {
    super();
    this.setData("name", "desktop_lyrics");
    this.requestCloseApproval(notifyDesktopLyricsClose);
    setupDesktopLyricsWindow(
      this.createBrowserWindow(desktopLyricsWindowOptions)
    );
  }
}

class DesktopLyricsOnDemandWindow extends OnDemandWindow {
  constructor() {
    super();
    this.setData("name", "desktop_lyrics");
    this.requestCloseApproval(notifyDesktopLyricsClose);
  }

  createWindow(): BrowserWindow {
    return setupDesktopLyricsWindow(
      this.createBrowserWindow(desktopLyricsWindowOptions)
    );
  }
}

/** `"on-demand"` destroys the window when hidden; anything else keeps it. */
function createWindowForLifecycle(value: unknown): ManagedWindow {
  return value === "on-demand"
    ? new DesktopLyricsOnDemandWindow()
    : new DesktopLyricsWindow();
}

let lifecycleSwitchRegistered = false;

/**
 * React to lifecycle changes without a restart.
 *
 * Registered from the startup path rather than at module scope: this module can
 * be evaluated before `settings.initialize()` creates the settings emitter.
 */
function registerLifecycleSwitch() {
  if (lifecycleSwitchRegistered) return;
  lifecycleSwitchRegistered = true;

  settingsEvents.on("change", (e) => {
    if (e.data.key !== "window.lifecycle" || !window) return;
    window = switchWindowPolicy(window, () =>
      createWindowForLifecycle(e.data.value)
    );
  });
}

export let window: ManagedWindow;
export default async function createDesktopLyricsWindow() {
  window = createWindowForLifecycle(await settings.get("window.lifecycle"));
  registerLifecycleSwitch();
}

// --- Preview ---

/** Offscreen window used only to rasterise a lyrics preview. */
class LyricsPreviewWindow extends ManagedWindow {
  constructor(options: BrowserWindowConstructorOptions) {
    super();
    this.createBrowserWindow(options);
  }
}

export async function createDesktopLyricsPreview(
  style: LyricsStyle,
  text: string
): Promise<[Buffer, [number, number]]> {
  const [width, height] = style.vertical ? [124, 310] : [310, 124];

  const previewWindow = new LyricsPreviewWindow({
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
      preload: join(import.meta.dirname, "desktop-lyrics-preview.js"),
    },
  }).window;
  if (!previewWindow) {
    throw new Error("Preview window was not created");
  }

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

    void previewWindow.loadURL(guiUrl("/desktop-lyrics-preview"));
  });
}
