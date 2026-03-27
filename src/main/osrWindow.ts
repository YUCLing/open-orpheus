/**
 * Offscreen-rendered window bridge.
 *
 * Creates an Electron `BrowserWindow` in offscreen mode and pairs it with a
 * native `OsrWindow` from the `@open-orpheus/ui` module.  Electron renders web
 * content to a bitmap which is forwarded to the native winit/wgpu window,
 * working around transparency issues on Linux Wayland / XWayland.
 *
 * Input events captured by the native window are forwarded back to Electron's
 * `webContents.sendInputEvent()` so the page behaves as if it had a normal
 * window.
 */
import { BrowserWindow } from "electron";

import { OsrWindow, type OsrInputEvent } from "@open-orpheus/ui";
import { getApp } from "./ui";

export interface OsrBrowserWindowOptions {
  /** Logical width of both windows. */
  width: number;
  /** Logical height of both windows. */
  height: number;
  /** Whether the native window should be transparent (default: true). */
  transparent?: boolean;
  /** Target frame rate for offscreen rendering (default: 60). */
  frameRate?: number;
  /** Window title. */
  title?: string;
  /** Keep the native window on top of other windows. */
  alwaysOnTop?: boolean;
  /** Hide from the taskbar / dock. */
  skipTaskbar?: boolean;
  /** Allow the native window to be resized by the user. */
  resizable?: boolean;
  /** Additional web preferences for BrowserWindow. */
  webPreferences?: Electron.WebPreferences;
}

export interface OsrBrowserWindowHandle {
  /** The native winit/wgpu window that the user sees. */
  osrWindow: OsrWindow;
  /** The hidden offscreen BrowserWindow that renders web content. */
  browserWindow: BrowserWindow;
  /** Tear down both windows and stop the paint bridge. */
  destroy(): void;
}

/**
 * Create an offscreen-rendered window.
 *
 * @returns A handle containing both the native and browser windows
 *          plus a `destroy()` helper.
 */
export async function createOsrBrowserWindow(
  options: OsrBrowserWindowOptions
): Promise<OsrBrowserWindowHandle> {
  const {
    width,
    height,
    transparent = true,
    frameRate = 60,
    title,
    alwaysOnTop = false,
    skipTaskbar = false,
    resizable = false,
    webPreferences = {},
  } = options;

  // ── Offscreen BrowserWindow ────────────────────────────────────────────
  const browserWindow = new BrowserWindow({
    width,
    height,
    show: false,
    transparent,
    webPreferences: {
      offscreen: true,
      ...webPreferences,
    },
  });

  browserWindow.webContents.setFrameRate(frameRate);

  // ── Native window ─────────────────────────────────────────────────────
  const app = getApp();
  const osrWindow = await OsrWindow.create(app, {
    width,
    height,
    transparent,
    alwaysOnTop,
    skipTaskbar,
    resizable,
    title,
  });

  // ── Paint bridge: Electron → native ────────────────────────────────────
  browserWindow.webContents.on("paint", (_event, _dirty, image) => {
    const size = image.getSize();
    const bitmap = image.toBitmap();
    osrWindow.updateFrame(bitmap, size.width, size.height);
  });

  // ── Cursor bridge: Electron → native ───────────────────────────────────
  browserWindow.webContents.on("cursor-changed", (_event, type) => {
    osrWindow.setCursor(type);
  });

  // ── Input bridge: native → Electron ────────────────────────────────────
  osrWindow.onInput((event: OsrInputEvent) => {
    forwardInputEvent(browserWindow, event);
  });

  return {
    osrWindow,
    browserWindow,
    destroy() {
      osrWindow.close();
      if (!browserWindow.isDestroyed()) {
        browserWindow.destroy();
      }
    },
  };
}

// ── Input event forwarding ───────────────────────────────────────────────────

function forwardInputEvent(bw: BrowserWindow, event: OsrInputEvent): void {
  const wc = bw.webContents;

  switch (event.type) {
    case "mouseMove":
      wc.sendInputEvent({
        type: "mouseMove",
        x: event.x!,
        y: event.y!,
      });
      break;

    case "mouseDown":
      wc.sendInputEvent({
        type: "mouseDown",
        x: event.x!,
        y: event.y!,
        button: electronButton(event.button),
        clickCount: event.click_count ?? 1,
      });
      break;

    case "mouseUp":
      wc.sendInputEvent({
        type: "mouseUp",
        x: event.x!,
        y: event.y!,
        button: electronButton(event.button),
      });
      break;

    case "mouseWheel":
      wc.sendInputEvent({
        type: "mouseWheel",
        x: event.x!,
        y: event.y!,
        deltaX: event.delta_x ?? 0,
        deltaY: event.delta_y ?? 0,
      });
      break;

    case "mouseEnter":
      wc.sendInputEvent({
        type: "mouseEnter",
        x: event.x!,
        y: event.y!,
      });
      break;

    case "mouseLeave":
      wc.sendInputEvent({
        type: "mouseLeave",
        x: 0,
        y: 0,
      });
      break;

    case "focus":
      bw.focus();
      break;

    case "blur":
      bw.blur();
      break;

    case "resize":
      if (event.width != null && event.height != null) {
        bw.setSize(event.width, event.height);
      }
      break;

    default:
      break;
  }
}

function electronButton(btn?: string): "left" | "right" | "middle" {
  if (btn === "right") return "right";
  if (btn === "middle") return "middle";
  return "left";
}
