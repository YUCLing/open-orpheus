import type { BrowserWindow } from "electron";
import {
  clearWindowPopupPolicy,
  isWindowPointerInside,
  isWindowWaylandPopup,
  setWindowPopupPolicy,
  windowLastPressAgeMs,
} from "@open-orpheus/window";
import { ManagedWindow } from "../window";
import { isLiveFocusedWindow } from "./lifecycle";

const WAYLAND_POPUP_ID_WAIT_MS = 200;
const WAYLAND_POPUP_ID_RETRY_MS = 5;
/** A press this fresh in the window waives the focus and pointer checks. */
const POPUP_ANCHOR_GRACE_MS = 100;
// Room for the same 16px blur / 4px vertical offset used by overlay menus.
export const NATIVE_MENU_SHADOW_INSET = 24;

export function waylandWindowId(wnd: BrowserWindow): string {
  const managed = ManagedWindow.fromBrowserWindow(wnd);
  if (!managed) throw new Error("popup requires a managed window");
  return managed.id;
}

/**
 * Whether `wnd` may anchor a native popup.
 *
 * A button press recorded in this window within the grace period is the
 * strongest evidence of intent — the user just clicked here — so both checks
 * below are skipped: the compositor may not have delivered the focus change or
 * the pointer enter yet. Otherwise the window has to be focused and have the
 * pointer over it, because a popup anchored to a window the user is not
 * working in has neither an anchor point nor a sensible place to appear.
 *
 * `windowLastPressAgeMs` answers `undefined` when the most recent press landed
 * somewhere else, so a press in another window is not mistaken for one here.
 */
export function canAnchorNativeWaylandPopup(wnd: BrowserWindow): boolean {
  const managed = ManagedWindow.fromBrowserWindow(wnd);
  if (!managed) return false;
  const pressedAgeMs = windowLastPressAgeMs(managed.id) ?? Number.POSITIVE_INFINITY;
  if (pressedAgeMs <= POPUP_ANCHOR_GRACE_MS) {
    LOGGER.debug(
      { windowId: managed.id, pressedAgeMs, anchorable: true },
      "Checked native Wayland popup anchor"
    );
    return true;
  }
  const focused = isLiveFocusedWindow(wnd);
  const pointerInside = isWindowPointerInside(managed.id);
  const anchorable = focused && pointerInside;
  LOGGER.debug(
    { windowId: managed.id, pressedAgeMs, focused, pointerInside, anchorable },
    "Checked native Wayland popup anchor"
  );
  return anchorable;
}

export async function waitForWaylandPopup(windowId: string, isCancelled: () => boolean) {
  const deadline = Date.now() + WAYLAND_POPUP_ID_WAIT_MS;
  while (!isCancelled()) {
    if (isWindowWaylandPopup(windowId)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, WAYLAND_POPUP_ID_RETRY_MS));
  }
  return false;
}

/**
 * Register `targetWindowId` as an xdg_popup of `parentWindowId`.
 *
 * Recorded against the target window id, like the layer-shell policy: the role
 * is decided when the window's decorated title names it, and the parent's
 * surface, the anchor and the object id are resolved then. Returns whether the
 * intent was accepted; the caller still confirms the conversion with
 * `waitForWaylandPopup` and keeps its overlay fallback.
 */
export function registerNativeWaylandPopup(
  parentWindowId: string,
  targetWindowId: string,
  width: number,
  height: number,
  anchor: { x: number; y: number } | undefined,
  shadowInset = NATIVE_MENU_SHADOW_INSET
): boolean {
  try {
    const registered = setWindowPopupPolicy(
      targetWindowId,
      parentWindowId,
      width,
      height,
      anchor?.x,
      anchor?.y,
      shadowInset
    );
    if (registered) {
      LOGGER.debug(
        { parentWindowId, targetWindowId, width, height, hasAnchor: anchor !== undefined },
        "Registered native Wayland popup"
      );
    }
    return registered;
  } catch {
    return false;
  }
}

/** Withdraw a popup policy the window is not going to use. */
export function clearNativeWaylandPopup(targetWindowId: string): boolean {
  try {
    return clearWindowPopupPolicy(targetWindowId);
  } catch {
    return false;
  }
}

/**
 * Release everything the native layer recorded for a window that is going away.
 *
 * Popup policies are keyed by window id, so a discarded window must drop its
 * own; the wrapper does that when it is collected, but a window destroyed here
 * would otherwise hold the policy until then.
 */
export function releaseNativeWindowState(wnd: BrowserWindow): void {
  ManagedWindow.fromBrowserWindow(wnd)?.releaseNativeState();
}
