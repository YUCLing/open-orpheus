import type { BrowserWindow } from "electron";
import {
  armNextWindowAsPopup,
  cancelPendingPopup,
  isWindowWaylandPopup,
} from "@open-orpheus/window";
import { ManagedWindow } from "../window";

const WAYLAND_POPUP_ID_WAIT_MS = 200;
const WAYLAND_POPUP_ID_RETRY_MS = 5;
const WAYLAND_POPUP_ARM_EXPIRY_MS = 5_000;
// Room for the same 16px blur / 4px vertical offset used by overlay menus.
export const NATIVE_MENU_SHADOW_INSET = 24;

export function waylandWindowId(wnd: BrowserWindow): string {
  const managed = ManagedWindow.fromBrowserWindow(wnd);
  if (!managed) throw new Error("popup requires a managed window");
  return managed.id;
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

export function armNativeWaylandPopupWhenReady(
  parentWindowId: string,
  targetWindowId: string,
  width: number,
  height: number,
  anchor: { x: number; y: number } | undefined,
  isCancelled: () => boolean,
  onArmed: (disposePending: () => void) => void,
  onUnavailable: (reason?: string, error?: unknown) => void,
  shadowInset = NATIVE_MENU_SHADOW_INSET
) {
  const deadline = Date.now() + WAYLAND_POPUP_ID_WAIT_MS;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const attempt = () => {
    if (cancelled || isCancelled()) return;
    let token: number | null;
    try {
      token = armNextWindowAsPopup(
        parentWindowId,
        targetWindowId,
        width,
        height,
        anchor?.x,
        anchor?.y,
        shadowInset
      );
    } catch (error) {
      onUnavailable("popup arming failed", error);
      return;
    }
    if (token !== null) {
      let pending = true;
      const expiryTimer = setTimeout(() => {
        if (!pending) return;
        pending = false;
        cancelPendingPopup(token);
        if (!cancelled && !isCancelled()) onUnavailable();
      }, WAYLAND_POPUP_ARM_EXPIRY_MS);
      const disposePending = () => {
        if (!pending) return;
        pending = false;
        clearTimeout(expiryTimer);
        cancelPendingPopup(token);
      };
      try {
        onArmed(disposePending);
      } catch (error) {
        disposePending();
        throw error;
      }
    } else if (Date.now() < deadline) {
      retryTimer = setTimeout(attempt, WAYLAND_POPUP_ID_RETRY_MS);
    } else {
      onUnavailable();
    }
  };
  attempt();
  return () => {
    cancelled = true;
    if (retryTimer) clearTimeout(retryTimer);
  };
}
