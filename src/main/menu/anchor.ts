import type { BrowserWindow } from "electron";

import { isWindowActivated, isWindowPointerInside, latestWindowPress } from "@open-orpheus/window";

import { ManagedWindow } from "../window";
import { TOUCH_ANCHOR_MAX_AGE_MS } from "./constants";

export interface AnchorSelection {
  window: BrowserWindow;
  x: number;
  y: number;
}

/**
 * Resolve the popup parent and anchor from native state.
 *
 * The latest press must belong to the activated window. Mouse presses also
 * require the pointer to remain inside it; touch presses expire after a while.
 */
export function selectAnchorCandidate(): AnchorSelection | null {
  const press = latestWindowPress();
  if (!press) return null;

  const activated = isWindowActivated(press.windowId);
  const pointerInside = isWindowPointerInside(press.windowId);
  const managed = ManagedWindow.fromId(press.windowId);
  const window = managed?.window;
  const validWindow = Boolean(window && !window.isDestroyed() && "webContents" in window);
  if (!activated || !validWindow) return null;
  if (press.touch) {
    if (press.ageMs > TOUCH_ANCHOR_MAX_AGE_MS) return null;
  } else if (!pointerInside) {
    // A mouse press is invalid once the pointer leaves the window.
    return null;
  }

  // The press target must be a BrowserWindow, not a menu BaseWindow.
  return { window: window as BrowserWindow, x: press.x, y: press.y };
}
